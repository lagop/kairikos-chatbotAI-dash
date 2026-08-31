import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// WP-XX — operator-managed Twilio credentials, saved through
// /admin/portal/settings/telephony instead of only ever living in
// TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN on the VPS .env.
//
// Same shape as stripe-credentials.ts (singleton row, 30s resolve cache,
// env fallback) with one real difference: Twilio has no test/live split,
// so there is no "active mode" to choose — a saved credential is simply
// in effect, no activation step.
// =============================================================================

// Singleton row — fixed id so getOrCreateCredentialRow() is a plain
// upsert, never a query that could race into two rows. Different id from
// StripeOperatorCredential's SINGLETON_ID — different table, but a
// distinct constant keeps the two from ever being confused if either is
// ever read from the wrong model by mistake.
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000f2';

function getEncryptionKey(): Buffer {
  return parseHexKey('TWILIO_CREDENTIAL_ENCRYPTION_KEY', process.env.TWILIO_CREDENTIAL_ENCRYPTION_KEY);
}

async function getOrCreateCredentialRow() {
  return prisma.twilioOperatorCredential.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

export interface TwilioCredentialStatus {
  configured: boolean;
  accountSid: string | null;
  authTokenLastFour: string | null;
  savedAt: string | null;
  // Not secret — shown in full, never masked, same as accountSid.
  bundleSid: string | null;
  addressSid: string | null;
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getTwilioCredentialStatus(): Promise<TwilioCredentialStatus> {
  const row = await getOrCreateCredentialRow();
  return {
    configured: row.authTokenCiphertext !== null,
    accountSid: row.accountSid,
    authTokenLastFour: row.authTokenLastFour,
    savedAt: row.savedAt ? row.savedAt.toISOString() : null,
    bundleSid: row.bundleSid,
    addressSid: row.addressSid,
  };
}

export interface CredentialActor {
  // null for the legacy x-kaia-operator-key path (its 'legacy' sentinel
  // is not a real Operator row id, so not a valid value for the
  // actorOperatorId FK — see the regulatory-ids route, the one caller
  // that can actually reach this with a legacy-authenticated request;
  // saveTwilioCredential's caller is step-up-gated and never sees it).
  operatorId: string | null;
  operatorEmail: string | null;
}

export async function saveTwilioCredential(
  accountSid: string,
  authToken: string,
  actor: CredentialActor,
): Promise<void> {
  const key = getEncryptionKey();
  const { ciphertext, iv, tag } = encryptBuffer(authToken, key);
  const lastFour = authToken.slice(-4);

  const before = await getTwilioCredentialStatus();

  await prisma.$transaction([
    prisma.twilioOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        accountSid,
        authTokenCiphertext: ciphertext,
        authTokenIv: iv,
        authTokenTag: tag,
        authTokenLastFour: lastFour,
        savedAt: new Date(),
      },
      update: {
        accountSid,
        authTokenCiphertext: ciphertext,
        authTokenIv: iv,
        authTokenTag: tag,
        authTokenLastFour: lastFour,
        savedAt: new Date(),
      },
    }),
    prisma.twilioCredentialAudit.create({
      data: {
        action: before.configured ? 'credential_rotated' : 'credential_saved',
        // Never the token or ciphertext — only non-sensitive metadata.
        before: { configured: before.configured, accountSid: before.accountSid },
        after: { configured: true, accountSid, lastFour },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateTwilioCredentialCache();
}

/**
 * Saves the Spanish numbering regulatory bundle/address SIDs — a
 * separate action from saveTwilioCredential on purpose: neither value is
 * secret, so this skips both the TOTP step-up gate and the verify-
 * against-Twilio call that guard the account credential pair (there is
 * no cheap way to validate a bundle/address SID in isolation short of
 * attempting a real number purchase, and a wrong one just fails cleanly
 * — and visibly — the next time someone provisions a number, not
 * silently or expensively). Same posture as the Google Places
 * integration-credential route, which also skips step-up for a
 * non-secret, low-blast-radius value.
 */
export async function saveTwilioRegulatoryIds(
  bundleSid: string,
  addressSid: string,
  actor: CredentialActor,
): Promise<void> {
  const before = await getOrCreateCredentialRow();

  await prisma.$transaction([
    prisma.twilioOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, bundleSid, addressSid },
      update: { bundleSid, addressSid },
    }),
    prisma.twilioCredentialAudit.create({
      data: {
        action: 'regulatory_ids_saved',
        before: { bundleSid: before.bundleSid, addressSid: before.addressSid },
        after: { bundleSid, addressSid },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateTwilioCredentialCache();
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  // Independently resolved (DB-first, env-fallback) from the account
  // pair above — an operator may migrate one before the other. null
  // when neither the DB row nor the env var has a value; provisionNumber
  // already treats a missing bundle/address as "omit that form field",
  // same as before this existed.
  bundleSid: string | null;
  addressSid: string | null;
}

interface CachedCredential extends TwilioCredentials {
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: CachedCredential | null = null;
let warnedEnvFallback = false;

/**
 * Resolves the Twilio config currently in effect: the DB-stored account
 * pair if one has been saved, else TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN
 * from the environment (pre-migration fallback, or a fresh environment
 * with nothing pasted yet) — plus bundleSid/addressSid, resolved the
 * same DB-first-else-env way but independently of the pair.
 *
 * Cached in-module with a 30s TTL — resolving requires a DB round-trip
 * plus a decrypt, and this is called on every Twilio API call and every
 * inbound webhook signature check. invalidateTwilioCredentialCache()
 * clears it immediately on the instance that performed a save; the TTL
 * bounds staleness on other warm serverless instances.
 */
export async function resolveActiveTwilioCredentials(): Promise<TwilioCredentials | null> {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    const { cachedAt: _cachedAt, ...credentials } = cached;
    return credentials;
  }

  const row = isDatabaseConfigured ? await getOrCreateCredentialRow() : null;

  let pair: { accountSid: string; authToken: string } | null = null;
  if (row?.accountSid && row.authTokenCiphertext && row.authTokenIv && row.authTokenTag) {
    const authToken = decryptBuffer(
      { ciphertext: row.authTokenCiphertext, iv: row.authTokenIv, tag: row.authTokenTag },
      getEncryptionKey(),
    );
    pair = { accountSid: row.accountSid, authToken };
  } else {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (accountSid && authToken) {
      if (!warnedEnvFallback) {
        warnedEnvFallback = true;
        console.warn(
          '[twilio-credentials] No Twilio credential saved in the database — falling back to TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN from the environment. Save one at /admin/portal/settings/telephony to stop seeing this.',
        );
      }
      pair = { accountSid, authToken };
    }
  }
  if (!pair) return null;

  const credentials: TwilioCredentials = {
    ...pair,
    bundleSid: row?.bundleSid ?? process.env.TWILIO_BUNDLE_SID ?? null,
    addressSid: row?.addressSid ?? process.env.TWILIO_ADDRESS_SID ?? null,
  };
  cached = { ...credentials, cachedAt: Date.now() };
  return credentials;
}

export function invalidateTwilioCredentialCache(): void {
  cached = null;
}
