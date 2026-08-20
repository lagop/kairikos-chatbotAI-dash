import 'server-only';
import { encryptChannelCredential, decryptChannelCredential } from './channel-crypto';
import type { EncryptedBuffer } from './operator-crypto';
import { logError } from './observability';

// =============================================================================
// WP: conexión de canales — Meta (WhatsApp/Messenger/Instagram), Fase 3.
//
// NOT a plain redirect-based OAuth like google-business.ts — this backs
// WhatsApp Embedded Signup, the flow Meta recommends for SaaS platforms.
// The client-side JS SDK (MetaChannelCard.tsx) opens Meta's own popup
// using a Business Login "configuration" (META_CONFIG_ID, created in the
// Meta App Dashboard — external setup, not built by this repo) and
// returns an authorization `code` via a callback, not a URL redirect.
// This module's job starts from that `code`.
//
// UNVERIFIED AGAINST A REAL META APP — unlike google-business.ts (which
// was built and tested against real Google OAuth) and the Telegram
// connector (verified live against the real Bot API this same session),
// there is no META_APP_ID/META_CONFIG_ID configured anywhere accessible
// to this environment. The Graph API shapes below follow Meta's
// documented, stable endpoints as closely as possible, but the first
// real signup attempt against a live Meta App is the actual test this
// code hasn't had.
//
// Design mirror of google-business.ts kept deliberately close: same
// fetch-direct-no-SDK convention, same encrypt/decrypt wrapper shape
// (channel-crypto.ts's shared Telegram+Meta key, not a new one — see
// that module's comment on why they're one secret class), same
// "portal hands off the token, n8n does platform-specific activation"
// boundary as Telegram (n8n calls WhatsApp's subscribed_apps/register
// endpoints after receiving the token via the channel webhook bridge —
// this module does not).
// =============================================================================

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION || 'v21.0';
}

// Exported so whatsapp-api.ts (and future Messenger/Instagram API
// modules) build Graph API URLs against the same version instead of
// hardcoding their own — one place controls what Graph API version
// this whole codebase targets.
export function graphUrl(path: string): string {
  return `https://graph.facebook.com/${graphVersion()}${path}`;
}

export function isMetaSignupConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_ID);
}

function getAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID/META_APP_SECRET not configured');
  }
  return { appId, appSecret };
}

export interface ExchangedMetaToken {
  accessToken: string;
  expiresIn: number | null;
}

/**
 * Exchanges the authorization `code` the client-side SDK returned for a
 * short-lived user access token. Embedded-Signup-initiated logins (via
 * config_id) do not use a redirect_uri in this exchange — the code is
 * bound to the app + the SDK session that produced it, not to a URL.
 */
export async function exchangeCodeForToken(code: string): Promise<ExchangedMetaToken | null> {
  const { appId, appSecret } = getAppCredentials();
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  try {
    const res = await fetch(`${graphUrl('/oauth/access_token')}?${params.toString()}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
  } catch (err) {
    logError('meta_business.exchange_code', err, { route: 'lib/meta-business.ts' }, 'warn');
    return null;
  }
}

/**
 * Short-lived (≈1-2h) → long-lived (≈60 days) token exchange. Meta has
 * no refresh-token concept here — a long-lived token that expires must
 * be re-obtained by asking the client to sign in again, which is why
 * `needs_reconnect` (mirroring Google's degraded-state handling) is the
 * right terminal state for an expired Meta connection, not a silent
 * background refresh.
 */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<ExchangedMetaToken | null> {
  const { appId, appSecret } = getAppCredentials();
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });
  try {
    const res = await fetch(`${graphUrl('/oauth/access_token')}?${params.toString()}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
  } catch (err) {
    logError('meta_business.exchange_long_lived', err, { route: 'lib/meta-business.ts' }, 'warn');
    return null;
  }
}

export interface MetaPageCandidate {
  pageId: string;
  pageName: string;
  /** Present only when this Page has a linked Instagram professional/business account. */
  instagramAccountId: string | null;
}

/**
 * Every Facebook Page (Messenger surface) the token's user manages, each
 * enriched with its linked Instagram business account id when present —
 * a single Graph call sequence covers both discovered channels
 * (messenger from the page itself, instagram from the linked account),
 * since Instagram professional accounts are always tied to a Page.
 */
export async function fetchPagesWithInstagram(accessToken: string): Promise<MetaPageCandidate[]> {
  try {
    const params = new URLSearchParams({
      access_token: accessToken,
      fields: 'id,name,instagram_business_account',
    });
    const res = await fetch(`${graphUrl('/me/accounts')}?${params.toString()}`);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; instagram_business_account?: { id?: string } }>;
    };
    return (json.data ?? [])
      .filter((p): p is { id: string; name?: string; instagram_business_account?: { id?: string } } => Boolean(p.id))
      .map((p) => ({
        pageId: p.id,
        pageName: p.name ?? p.id,
        instagramAccountId: p.instagram_business_account?.id ?? null,
      }));
  } catch (err) {
    logError('meta_business.fetch_pages', err, { route: 'lib/meta-business.ts' }, 'warn');
    return [];
  }
}

/**
 * Best-effort revoke — Meta's closest equivalent to Google's /revoke is
 * dropping every permission the app was granted for this user
 * (`DELETE /me/permissions`), matching the "disconnect never leaves the
 * client stuck locally-connected-but-actually-revoked" intent, but also
 * matching Google's precedent of NOT being a precondition for local
 * disconnect to succeed — failure here is logged, never fatal.
 */
export async function revokeMetaAccess(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${graphUrl('/me/permissions')}?${new URLSearchParams({ access_token: accessToken }).toString()}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch (err) {
    logError('meta_business.revoke_access', err, { route: 'lib/meta-business.ts' }, 'warn');
    return false;
  }
}

export function encryptMetaToken(plaintext: string): EncryptedBuffer {
  return encryptChannelCredential(plaintext);
}

export function decryptMetaToken(parts: EncryptedBuffer): string {
  return decryptChannelCredential(parts);
}
