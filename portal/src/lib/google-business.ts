import 'server-only';
import { prisma } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey, type EncryptedBuffer } from './operator-crypto';
import { logError } from './observability';
import { resolveIntegrationClientId, resolveIntegrationSecret } from './integration-credentials';

// DB-first, env-fallback for the OAuth client pair — same posture as
// resolveActiveTwilioCredentials(): an operator can paste these at
// /admin/portal/settings/integrations instead of setting
// GOOGLE_BUSINESS_OAUTH_CLIENT_ID/SECRET on the VPS.
const TOOL_KEY = 'google_business';
import { isProductContracted } from './client-product-access';

// =============================================================================
// WP-21 — OAuth connection to a client's own Google Business Profile, so
// WP-22 can sync and reply to that location's reviews on their behalf.
//
// Deliberately a SEPARATE OAuth client (GOOGLE_BUSINESS_OAUTH_CLIENT_ID/
// SECRET) from GOOGLE_OAUTH_CLIENT_ID/SECRET in lib/google-drive.ts
// (KAIA-2913): that one authorizes Kairikos's OWN Google account for
// internal Drive provisioning via a single static refresh token; this one
// authorizes each CLIENT's Google account, one connection per location,
// via a `business.manage`-scoped consent screen. Mixing the two would
// conflate unrelated OAuth review scopes and credential sets.
//
// Calls Google's REST endpoints directly via fetch, matching the existing
// google-drive.ts convention rather than adding a new SDK dependency for
// a handful of endpoints.
// =============================================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const locationsUrl = (accountName: string) =>
  `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`;
const locationMetadataUrl = (locationName: string) =>
  `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=metadata`;

// A single scope covers every Business Profile management call this
// integration needs (accounts, locations, reviews) — see the WP-20
// research: Account Management + Business Information + Reviews all sit
// under business.manage.
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

/** Shared between the start and callback routes — kept here rather than
 *  imported cross-route-file so neither route.ts module has to import
 *  from the other's. */
export const OAUTH_STATE_COOKIE = 'gb_oauth_state';

/** Which page started the flow, so the callback can send the client
 *  back where they came from. Set alongside OAUTH_STATE_COOKIE, same
 *  lifetime and path. */
export const OAUTH_RETURN_COOKIE = 'gb_oauth_return';

/** The standalone 'reviews' product owns /portal/resenas; 'recall'
 *  bundles the same review-request flow over WhatsApp (see
 *  recall-reviews.ts) and needs the same connection but has no other
 *  screen to get it from — this is that flow's single access check,
 *  mirroring hasLeadsInboxAccess's "either product unlocks it" shape. */
export async function hasGoogleBusinessConnectAccess(clientId: string): Promise<boolean> {
  const [hasReviews, hasRecall] = await Promise.all([
    isProductContracted(prisma, clientId, 'reviews'),
    isProductContracted(prisma, clientId, 'recall'),
  ]);
  return hasReviews || hasRecall;
}

export async function isGoogleBusinessOAuthConfigured(): Promise<boolean> {
  const { clientId, clientSecret } = await resolveClientCredentials();
  return Boolean(clientId && clientSecret && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

async function resolveClientCredentials(): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const [clientId, clientSecret] = await Promise.all([
    resolveIntegrationClientId(TOOL_KEY),
    resolveIntegrationSecret(TOOL_KEY),
  ]);
  return {
    clientId: clientId ?? process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID ?? null,
    clientSecret: clientSecret ?? process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET ?? null,
  };
}

async function getClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const { clientId, clientSecret } = await resolveClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_BUSINESS_OAUTH_CLIENT_ID/GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET not configured');
  }
  return { clientId, clientSecret };
}

function getTokenEncryptionKey(): Buffer {
  return parseHexKey('GOOGLE_TOKEN_ENCRYPTION_KEY', process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

function getRedirectUri(): string {
  const explicit = process.env.GOOGLE_BUSINESS_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/portal/google-business/oauth/callback`;
}

/** Builds the Google consent-screen URL. `state` is opaque here — the
 *  caller is responsible for minting it and validating it against the
 *  session on callback (the CSRF protection this WP's AC requires). */
export async function buildAuthorizationUrl(state: string): Promise<string> {
  const { clientId } = await getClientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
    // offline + consent guarantees Google returns a refresh_token even
    // if this client previously granted access — without `prompt=consent`
    // a returning user's re-auth silently omits refresh_token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}

export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens | null> {
  const { clientId, clientSecret } = await getClientCredentials();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
  });
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!json.access_token) return null;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresIn: json.expires_in ?? 3600,
      scope: json.scope ?? '',
    };
  } catch (err) {
    logError('google_business.exchange_code', err, { route: 'lib/google-business.ts' }, 'warn');
    return null;
  }
}

export interface GoogleLocationCandidate {
  /** Resource name, e.g. "accounts/123456789". */
  accountId: string;
  accountName: string;
  /** Resource name, e.g. "accounts/123456789/locations/987654321". */
  locationId: string;
  locationName: string;
}

/** Every location across every account the just-connected Google user has
 *  Business Profile access to. The caller decides what to do with more
 *  than one — see the OAuth callback route for the current (single-
 *  location-only) policy. */
export async function fetchAccessibleLocations(accessToken: string): Promise<GoogleLocationCandidate[]> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const accountsRes = await fetch(ACCOUNTS_URL, { headers });
  if (!accountsRes.ok) return [];
  const accountsJson = (await accountsRes.json()) as {
    accounts?: Array<{ name?: string; accountName?: string }>;
  };
  const accounts = accountsJson.accounts ?? [];

  const results: GoogleLocationCandidate[] = [];
  for (const account of accounts) {
    if (!account.name) continue;
    const locRes = await fetch(locationsUrl(account.name), { headers });
    if (!locRes.ok) continue;
    const locJson = (await locRes.json()) as { locations?: Array<{ name?: string; title?: string }> };
    for (const loc of locJson.locations ?? []) {
      if (!loc.name) continue;
      results.push({
        accountId: account.name,
        accountName: account.accountName ?? account.name,
        locationId: loc.name,
        locationName: loc.title ?? loc.name,
      });
    }
  }
  return results;
}

/**
 * WP-22b — fetches Google's own "leave a review" link for a location
 * (Location.metadata.newReviewUri via the Business Information API).
 * Returns null on any failure (missing field, non-ok response, network
 * error) rather than throwing — the caller decides whether "no review
 * link yet" blocks campaign creation.
 */
export async function fetchLocationReviewUrl(accessToken: string, locationId: string): Promise<string | null> {
  try {
    const res = await fetch(locationMetadataUrl(locationId), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { metadata?: { newReviewUri?: string } };
    return json.metadata?.newReviewUri ?? null;
  } catch (err) {
    logError('google_business.fetch_review_url', err, { route: 'lib/google-business.ts' }, 'warn');
    return null;
  }
}

export type PublishReplyResult =
  | { ok: true }
  | { ok: false; error: 'needs_reconnect' | 'api_error'; detail?: string };

/**
 * WP-22c — publishes a reply to a review via the Reviews API v4
 * (`PUT .../reply`). `reviewResourceName` is a review's full Google
 * resource name (GoogleReview.googleReviewId). A 401/403 response is
 * reported as `needs_reconnect` specifically — the caller (the publish
 * route) turns that into the AC's "mensaje claro de reconexión" instead
 * of a generic failure.
 */
export async function publishReviewReply(accessToken: string, reviewResourceName: string, comment: string): Promise<PublishReplyResult> {
  try {
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ comment }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'needs_reconnect' };
    }
    const detail = await res.text().catch(() => '');
    return { ok: false, error: 'api_error', detail: detail.slice(0, 300) };
  } catch (err) {
    logError('google_business.publish_reply', err, { route: 'lib/google-business.ts' }, 'warn');
    return { ok: false, error: 'api_error', detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

/** Revoke a token (access or refresh) at Google — the AC that a
 *  disconnect from the portal invalidates the grant at Google's end too,
 *  not just the local row. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch (err) {
    logError('google_business.revoke_token', err, { route: 'lib/google-business.ts' }, 'warn');
    return false;
  }
}

export function encryptRefreshToken(plaintext: string): EncryptedBuffer {
  return encryptBuffer(plaintext, getTokenEncryptionKey());
}

export function decryptRefreshToken(parts: EncryptedBuffer): string {
  return decryptBuffer(parts, getTokenEncryptionKey());
}

interface StoredConnection {
  id: string;
  refreshTokenCiphertext: Buffer;
  refreshTokenIv: Buffer;
  refreshTokenTag: Buffer;
}

/**
 * Mints a fresh access token for a connection by decrypting its stored
 * refresh token and exchanging it. On `invalid_grant` — Google's
 * canonical "this refresh token no longer works" error, returned when
 * the client revoked access from their own Google account or the grant
 * expired — the connection is flipped to `needs_reconnect` right here,
 * the ONE place that interprets that error shape, so every caller
 * (a sync job, a manual refresh, a status check) gets the same degraded-
 * state behavior for free instead of re-implementing the interpretation.
 */
export async function getValidAccessToken(connection: StoredConnection): Promise<string | null> {
  let refreshToken: string;
  try {
    refreshToken = decryptRefreshToken({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      tag: connection.refreshTokenTag,
    });
  } catch (err) {
    logError('google_business.decrypt_refresh_token', err, {
      route: 'lib/google-business.ts',
      connectionId: connection.id,
    });
    return null;
  }

  try {
    // getClientCredentials() throws when GOOGLE_BUSINESS_OAUTH_CLIENT_ID/SECRET
    // aren't set — deliberately inside this try, not called before it.
    // A connection ROW can already exist (created while OAuth was
    // configured) even after the env var is later unset, so this is a
    // real reachable path, not a theoretical one.
    const { clientId, clientSecret } = await getClientCredentials();
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
      if (errJson?.error === 'invalid_grant') {
        await prisma.googleBusinessConnection
          .update({
            where: { id: connection.id },
            data: { status: 'needs_reconnect', lastSyncError: 'invalid_grant: reconexión necesaria' },
          })
          .catch(() => null);
      }
      return null;
    }
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch (err) {
    logError('google_business.refresh_access_token', err, {
      route: 'lib/google-business.ts',
      connectionId: connection.id,
    });
    return null;
  }
}
