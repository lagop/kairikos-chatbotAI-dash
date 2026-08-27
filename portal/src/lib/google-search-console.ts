import 'server-only';
import { prisma } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey, type EncryptedBuffer } from './operator-crypto';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase B — OAuth connection to a client's own Google Search
// Console property, mirroring lib/google-business.ts's shape closely (same
// OAuth2 mechanism, same encryption posture) but for a DIFFERENT, dedicated
// OAuth client (GOOGLE_SEO_OAUTH_CLIENT_ID/SECRET) — see
// GoogleSeoConnection's own schema comment for why this doesn't reuse
// GoogleBusinessConnection's OAuth client or scope.
//
// Endpoint shapes verified against Google's current published docs
// (developers.google.com/webmaster-tools/v1/{sites,sites.list},
// fetched Aug 2026) — sites.list's `siteUrl`/`permissionLevel` field
// names and enum values are not guessed.
//
// UNVERIFIED AGAINST A REAL GOOGLE SEO OAUTH CLIENT — same standing
// caveat as google-business.ts and google-places.ts: no credentials
// reachable from any environment this code has been built in.
// =============================================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

// Search Console only, v1 — GA4 needs its own property-picker UI (a GA4
// property is a numeric id with a display name, not reliably
// URL-matchable) and lands as a later, separate piece. See
// GoogleSeoConnection's schema comment.
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** Permission levels that mean the user actually has verified, readable
 *  access — 'siteUnverifiedUser' means verification is still pending at
 *  Google, not usable for API reads. */
const VERIFIED_PERMISSION_LEVELS = new Set(['siteFullUser', 'siteOwner', 'siteRestrictedUser']);

export const OAUTH_STATE_COOKIE = 'seo_gsc_oauth_state';

export function isSearchConsoleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SEO_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_SEO_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_SEO_TOKEN_ENCRYPTION_KEY,
  );
}

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_SEO_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SEO_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_SEO_OAUTH_CLIENT_ID/GOOGLE_SEO_OAUTH_CLIENT_SECRET not configured');
  }
  return { clientId, clientSecret };
}

function getTokenEncryptionKey(): Buffer {
  return parseHexKey('GOOGLE_SEO_TOKEN_ENCRYPTION_KEY', process.env.GOOGLE_SEO_TOKEN_ENCRYPTION_KEY);
}

function getRedirectUri(): string {
  const explicit = process.env.GOOGLE_SEO_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/portal/seo/oauth/callback`;
}

export function buildAuthorizationUrl(state: string): string {
  const { clientId } = getClientCredentials();
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
  const { clientId, clientSecret } = getClientCredentials();
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
    logError('google_search_console.exchange_code', err, { route: 'lib/google-search-console.ts' }, 'warn');
    return null;
  }
}

interface RawSiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

/**
 * Every Search Console property the just-connected Google user has
 * VERIFIED access to (siteUnverifiedUser entries are filtered out — see
 * VERIFIED_PERMISSION_LEVELS). The caller matches these against
 * SeoProfile.siteUrl — see the OAuth callback route for the current
 * (single-match-or-error) policy.
 */
export async function fetchVerifiedSites(accessToken: string): Promise<string[]> {
  try {
    const res = await fetch(SITES_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    const json = (await res.json()) as { siteEntry?: RawSiteEntry[] };
    return (json.siteEntry ?? [])
      .filter((entry) => entry.siteUrl && entry.permissionLevel && VERIFIED_PERMISSION_LEVELS.has(entry.permissionLevel))
      .map((entry) => entry.siteUrl as string);
  } catch (err) {
    logError('google_search_console.fetch_sites', err, { route: 'lib/google-search-console.ts' }, 'warn');
    return [];
  }
}

/**
 * Matches a client's plain siteUrl (e.g. "https://negocio.example") against
 * a list of verified Search Console properties, which come in two
 * formats: URL-prefix ("https://negocio.example/") or Domain
 * ("sc-domain:negocio.example"). Compares by hostname so trailing
 * slashes/http-vs-https don't cause a false miss.
 */
export function matchVerifiedSite(clientSiteUrl: string, verifiedSites: string[]): string | null {
  let hostname: string;
  try {
    hostname = new URL(clientSiteUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const site of verifiedSites) {
    if (site.startsWith('sc-domain:')) {
      const domain = site.slice('sc-domain:'.length).replace(/^www\./, '');
      if (domain === hostname) return site;
      continue;
    }
    try {
      const siteHostname = new URL(site).hostname.replace(/^www\./, '');
      if (siteHostname === hostname) return site;
    } catch {
      continue;
    }
  }
  return null;
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
    logError('google_search_console.revoke_token', err, { route: 'lib/google-search-console.ts' }, 'warn');
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
 * reasoning as google-business.ts's getValidAccessToken.
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
    logError('google_search_console.decrypt_refresh_token', err, {
      route: 'lib/google-search-console.ts',
      connectionId: connection.id,
    });
    return null;
  }

  const { clientId, clientSecret } = getClientCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
      if (errJson?.error === 'invalid_grant') {
        await prisma.googleSeoConnection
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
    logError('google_search_console.refresh_access_token', err, {
      route: 'lib/google-search-console.ts',
      connectionId: connection.id,
    });
    return null;
  }
}
