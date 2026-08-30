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
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getTwilioCredentialStatus(): Promise<TwilioCredentialStatus> {
  const row = await getOrCreateCredentialRow();
  return {
    configured: row.authTokenCiphertext !== null,
    accountSid: row.accountSid,
    authTokenLastFour: row.authTokenLastFour,
    savedAt: row.savedAt ? row.savedAt.toISOString() : null,
  };
}

export interface CredentialActor {
  operatorId: string;
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

interface CachedCredential {
  accountSid: string;
  authToken: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: CachedCredential | null = null;
let warnedEnvFallback = false;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * Resolves the Twilio credentials currently in effect: the DB-stored pair
 * if one has been saved, else TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN from
 * the environment (pre-migration fallback, or a fresh environment with
 * nothing pasted yet).
 *
 * Cached in-module with a 30s TTL — resolving requires a DB round-trip
 * plus a decrypt, and this is called on every Twilio API call and every
 * inbound webhook signature check. invalidateTwilioCredentialCache()
 * clears it immediately on the instance that performed a save; the TTL
 * bounds staleness on other warm serverless instances.
 */
export async function resolveActiveTwilioCredentials(): Promise<TwilioCredentials | null> {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { accountSid: cached.accountSid, authToken: cached.authToken };
  }

  if (isDatabaseConfigured) {
    const row = await getOrCreateCredentialRow();
    if (row.accountSid && row.authTokenCiphertext && row.authTokenIv && row.authTokenTag) {
      const authToken = decryptBuffer(
        { ciphertext: row.authTokenCiphertext, iv: row.authTokenIv, tag: row.authTokenTag },
        getEncryptionKey(),
      );
      cached = { accountSid: row.accountSid, authToken, cachedAt: Date.now() };
      return { accountSid: row.accountSid, authToken };
    }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    if (!warnedEnvFallback) {
      warnedEnvFallback = true;
      console.warn(
        '[twilio-credentials] No Twilio credential saved in the database — falling back to TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN from the environment. Save one at /admin/portal/settings/telephony to stop seeing this.',
      );
    }
    cached = { accountSid, authToken, cachedAt: Date.now() };
    return { accountSid, authToken };
  }

  return null;
}

export function invalidateTwilioCredentialCache(): void {
  cached = null;
}
