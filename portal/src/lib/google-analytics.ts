import 'server-only';
import { prisma } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey, type EncryptedBuffer } from './operator-crypto';
import { logError } from './observability';
import { resolveIntegrationClientId, resolveIntegrationSecret } from './integration-credentials';

// DB-first, env-fallback for the OAuth client pair — see google-business.ts's
// identical resolveClientCredentials() for the reasoning.
const TOOL_KEY = 'google_ga4';

// =============================================================================
// SEO con IA — GA4/Analytics OAuth connection. Mirrors
// google-search-console.ts's shape/mechanism closely (same OAuth2
// dance, same encryption posture), but for a DIFFERENT, dedicated
// OAuth client (GOOGLE_GA4_OAUTH_CLIENT_ID/SECRET) — see
// GoogleAnalyticsConnection's own schema comment for why.
//
// Endpoint shapes verified against Google's current published docs
// (developers.google.com/analytics/devguides/config/admin/v1 and
// .../reporting/data/v1, fetched Sep 2026) — accountSummaries.list's
// nesting (accountSummaries[].propertySummaries[].property/displayName)
// and runReport's request/response field names are not guessed.
//
// UNVERIFIED AGAINST A REAL GOOGLE ANALYTICS OAUTH CLIENT — same
// standing caveat as every other Google integration built this
// session: no credentials reachable from any environment this code
// has been built in.
// =============================================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ACCOUNT_SUMMARIES_URL = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries';

// Read-only — this connection only ever reports on a client's existing
// GA4 property, never edits Analytics configuration.
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export const OAUTH_STATE_COOKIE = 'seo_ga4_oauth_state';

export async function isAnalyticsOAuthConfigured(): Promise<boolean> {
  const { clientId, clientSecret } = await resolveClientCredentials();
  return Boolean(clientId && clientSecret && process.env.GOOGLE_GA4_TOKEN_ENCRYPTION_KEY);
}

async function resolveClientCredentials(): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const [clientId, clientSecret] = await Promise.all([
    resolveIntegrationClientId(TOOL_KEY),
    resolveIntegrationSecret(TOOL_KEY),
  ]);
  return {
    clientId: clientId ?? process.env.GOOGLE_GA4_OAUTH_CLIENT_ID ?? null,
    clientSecret: clientSecret ?? process.env.GOOGLE_GA4_OAUTH_CLIENT_SECRET ?? null,
  };
}

async function getClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const { clientId, clientSecret } = await resolveClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_GA4_OAUTH_CLIENT_ID/GOOGLE_GA4_OAUTH_CLIENT_SECRET not configured');
  }
  return { clientId, clientSecret };
}

function getTokenEncryptionKey(): Buffer {
  return parseHexKey('GOOGLE_GA4_TOKEN_ENCRYPTION_KEY', process.env.GOOGLE_GA4_TOKEN_ENCRYPTION_KEY);
}

function getRedirectUri(): string {
  const explicit = process.env.GOOGLE_GA4_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/portal/seo/analytics/oauth/callback`;
}

export async function buildAuthorizationUrl(state: string): Promise<string> {
  const { clientId } = await getClientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
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
    logError('google_analytics.exchange_code', err, { route: 'lib/google-analytics.ts' }, 'warn');
    return null;
  }
}

export interface AnalyticsProperty {
  propertyId: string; // "properties/123456"
  displayName: string;
  accountDisplayName: string;
}

interface RawPropertySummary {
  property?: string;
  displayName?: string;
}
interface RawAccountSummary {
  displayName?: string;
  propertySummaries?: RawPropertySummary[];
}

/**
 * Every GA4 property the just-connected Google user has access to,
 * flattened across every Analytics account they belong to — a client
 * with more than one property picks theirs from this list (the picker
 * UI), rather than the portal guessing. Does not paginate — v1 only
 * fetches the first page (Google's default page size, 200 accounts),
 * which comfortably covers a single small business's Analytics setup;
 * a client with more accounts than that is not the target user.
 */
export async function fetchAccessibleProperties(accessToken: string): Promise<AnalyticsProperty[]> {
  try {
    const res = await fetch(ACCOUNT_SUMMARIES_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    const json = (await res.json()) as { accountSummaries?: RawAccountSummary[] };
    const properties: AnalyticsProperty[] = [];
    for (const account of json.accountSummaries ?? []) {
      for (const summary of account.propertySummaries ?? []) {
        if (!summary.property || !summary.displayName) continue;
        properties.push({
          propertyId: summary.property,
          displayName: summary.displayName,
          accountDisplayName: account.displayName ?? '',
        });
      }
    }
    return properties;
  } catch (err) {
    logError('google_analytics.fetch_properties', err, { route: 'lib/google-analytics.ts' }, 'warn');
    return [];
  }
}

export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch (err) {
    logError('google_analytics.revoke_token', err, { route: 'lib/google-analytics.ts' }, 'warn');
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
 * Mints a fresh access token by decrypting the stored refresh token and
 * exchanging it. On `invalid_grant` the connection flips to
 * 'needs_reconnect' right here — same single-interpretation-point
 * reasoning as google-search-console.ts's getValidAccessToken.
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
    logError('google_analytics.decrypt_refresh_token', err, {
      route: 'lib/google-analytics.ts',
      connectionId: connection.id,
    });
    return null;
  }

  try {
    // getClientCredentials() throws when GOOGLE_GA4_OAUTH_CLIENT_ID/SECRET
    // aren't set — deliberately inside this try, not called before it.
    // A connection ROW can already exist (created while OAuth was
    // configured) even after the env var is later unset, so this is a
    // real reachable path, not a theoretical one — caught live via this
    // feature's own browser verification, where it 500'd before this fix.
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
        await prisma.googleAnalyticsConnection
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
    logError('google_analytics.refresh_access_token', err, {
      route: 'lib/google-analytics.ts',
      connectionId: connection.id,
    });
    return null;
  }
}
