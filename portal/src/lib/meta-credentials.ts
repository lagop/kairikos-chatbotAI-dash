import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// Operator-managed Meta app credentials, saved through
// /admin/portal/settings/meta instead of only ever living in
// META_APP_ID/META_APP_SECRET/META_CONFIG_ID/META_COEXISTENCE_CONFIG_ID
// on the VPS .env.
//
// Same shape as twilio-credentials.ts (singleton row, 30s resolve cache,
// env fallback) with one real difference: Meta needs FOUR fields, not
// two — appId+appSecret pair with the standard OAuth-client shape, but
// configId and coexistenceConfigId are a THIRD and FOURTH piece of
// non-secret configuration (which Embedded Signup Configuration the
// popup opens with), not credentials at all. See meta-business.ts's
// header for why the two config ids can't be merged into one.
// =============================================================================

// Singleton row — fixed id so getOrCreateCredentialRow() is a plain
// upsert, never a query that could race into two rows. Distinct from
// every other *OperatorCredential SINGLETON_ID so a misdirected read
// can never silently resolve against the wrong table's row.
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000f3';

function getEncryptionKey(): Buffer {
  return parseHexKey('META_CREDENTIAL_ENCRYPTION_KEY', process.env.META_CREDENTIAL_ENCRYPTION_KEY);
}

async function getOrCreateCredentialRow() {
  return prisma.metaOperatorCredential.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

export interface MetaCredentialStatus {
  configured: boolean;
  appId: string | null;
  appSecretLastFour: string | null;
  savedAt: string | null;
  // Not secret — shown in full, never masked, same as appId.
  configId: string | null;
  coexistenceConfigId: string | null;
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getMetaCredentialStatus(): Promise<MetaCredentialStatus> {
  const row = await getOrCreateCredentialRow();
  return {
    configured: row.appSecretCiphertext !== null,
    appId: row.appId,
    appSecretLastFour: row.appSecretLastFour,
    savedAt: row.savedAt ? row.savedAt.toISOString() : null,
    configId: row.configId,
    coexistenceConfigId: row.coexistenceConfigId,
  };
}

export interface CredentialActor {
  // null for the legacy x-kaia-operator-key path (its 'legacy' sentinel
  // is not a real Operator row id, so not a valid value for the
  // actorOperatorId FK — see the config-ids route, the one caller that
  // can actually reach this with a legacy-authenticated request;
  // saveMetaCredential's caller is step-up-gated and never sees it).
  operatorId: string | null;
  operatorEmail: string | null;
}

/**
 * Saves (or rotates) the operator's Meta app id/secret pair. Callers
 * (the credentials route) require a fresh TOTP step-up and verify the
 * pair against Meta before calling this — this function itself trusts
 * that both already happened, same division of responsibility as
 * saveTwilioCredential.
 */
export async function saveMetaCredential(appId: string, appSecret: string, actor: CredentialActor): Promise<void> {
  const key = getEncryptionKey();
  const { ciphertext, iv, tag } = encryptBuffer(appSecret, key);
  const lastFour = appSecret.slice(-4);

  const before = await getMetaCredentialStatus();

  await prisma.$transaction([
    prisma.metaOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        appId,
        appSecretCiphertext: ciphertext,
        appSecretIv: iv,
        appSecretTag: tag,
        appSecretLastFour: lastFour,
        savedAt: new Date(),
      },
      update: {
        appId,
        appSecretCiphertext: ciphertext,
        appSecretIv: iv,
        appSecretTag: tag,
        appSecretLastFour: lastFour,
        savedAt: new Date(),
      },
    }),
    prisma.metaCredentialAudit.create({
      data: {
        action: before.configured ? 'credential_rotated' : 'credential_saved',
        // Never the secret or ciphertext — only non-sensitive metadata.
        before: { configured: before.configured, appId: before.appId },
        after: { configured: true, appId, lastFour },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateMetaCredentialCache();
}

/**
 * Saves the two Embedded Signup Configuration ids — a separate action
 * from saveMetaCredential on purpose: neither value is secret, so this
 * skips both the TOTP step-up gate and the verify-against-Meta call
 * that guard the app id/secret pair (there is no cheap way to validate
 * a config_id in isolation short of a real signup attempt, and a wrong
 * one just fails cleanly — and visibly — the next time a client tries
 * to connect, not silently or expensively). Same posture as
 * saveTwilioRegulatoryIds.
 */
export async function saveMetaConfigIds(
  configId: string,
  coexistenceConfigId: string,
  actor: CredentialActor,
): Promise<void> {
  const before = await getOrCreateCredentialRow();

  await prisma.$transaction([
    prisma.metaOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, configId, coexistenceConfigId },
      update: { configId, coexistenceConfigId },
    }),
    prisma.metaCredentialAudit.create({
      data: {
        action: 'config_ids_saved',
        before: { configId: before.configId, coexistenceConfigId: before.coexistenceConfigId },
        after: { configId, coexistenceConfigId },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateMetaCredentialCache();
}

export interface MetaCredentials {
  appId: string;
  appSecret: string;
  // Independently resolved (DB-first, env-fallback) from the appId/
  // appSecret pair above — an operator may migrate one before the
  // other, or run with one config id set and not the other while a
  // Coexistence Configuration is still being set up in the Meta App
  // Dashboard. null when neither the DB row nor the env var has a
  // value — callers already treat a missing config id as "that flow
  // isn't configured yet", same as before this existed.
  configId: string | null;
  coexistenceConfigId: string | null;
}

interface CachedCredential extends MetaCredentials {
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: CachedCredential | null = null;
let warnedEnvFallback = false;

/**
 * Resolves the Meta config currently in effect: the DB-stored appId/
 * appSecret pair if one has been saved, else META_APP_ID/META_APP_SECRET
 * from the environment (pre-migration fallback) — plus configId/
 * coexistenceConfigId, resolved the same DB-first-else-env way but
 * independently of the pair.
 *
 * Cached in-module with a 30s TTL — resolving requires a DB round-trip
 * plus a decrypt, and this is called on every Meta Graph API call this
 * app makes. invalidateMetaCredentialCache() clears it immediately on
 * the instance that performed a save; the TTL bounds staleness on other
 * warm serverless instances.
 */
export async function resolveActiveMetaCredentials(): Promise<MetaCredentials | null> {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    const { cachedAt: _cachedAt, ...credentials } = cached;
    return credentials;
  }

  const row = isDatabaseConfigured ? await getOrCreateCredentialRow() : null;

  let pair: { appId: string; appSecret: string } | null = null;
  if (row?.appId && row.appSecretCiphertext && row.appSecretIv && row.appSecretTag) {
    const appSecret = decryptBuffer(
      { ciphertext: row.appSecretCiphertext, iv: row.appSecretIv, tag: row.appSecretTag },
      getEncryptionKey(),
    );
    pair = { appId: row.appId, appSecret };
  } else {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (appId && appSecret) {
      if (!warnedEnvFallback) {
        warnedEnvFallback = true;
        console.warn(
          '[meta-credentials] No Meta credential saved in the database — falling back to META_APP_ID/META_APP_SECRET from the environment. Save one at /admin/portal/settings/meta to stop seeing this.',
        );
      }
      pair = { appId, appSecret };
    }
  }
  if (!pair) return null;

  const credentials: MetaCredentials = {
    ...pair,
    configId: row?.configId ?? process.env.META_CONFIG_ID ?? null,
    coexistenceConfigId: row?.coexistenceConfigId ?? process.env.META_COEXISTENCE_CONFIG_ID ?? null,
  };
  cached = { ...credentials, cachedAt: Date.now() };
  return credentials;
}

export function invalidateMetaCredentialCache(): void {
  cached = null;
}
