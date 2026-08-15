import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

export type StripeMode = 'test' | 'live';

export interface CatalogActor {
  operatorId: string;
  operatorEmail: string | null;
}

// Singleton row — see the StripeOperatorCredential model comment in
// schema.prisma for why this is a single wide row instead of one row
// per mode. Fixed id so getOrCreateCredentialRow() is a plain upsert,
// never a query that could race into two rows.
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000f1';

function getEncryptionKey(): Buffer {
  return parseHexKey('STRIPE_CREDENTIAL_ENCRYPTION_KEY', process.env.STRIPE_CREDENTIAL_ENCRYPTION_KEY);
}

async function getOrCreateCredentialRow() {
  return prisma.stripeOperatorCredential.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

export interface StripeModeCredentialStatus {
  configured: boolean;
  lastFour: string | null;
  savedAt: string | null;
}

export interface StripeCredentialStatus {
  activeMode: StripeMode | null;
  test: StripeModeCredentialStatus;
  live: StripeModeCredentialStatus;
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getStripeCredentialStatus(): Promise<StripeCredentialStatus> {
  const row = await getOrCreateCredentialRow();
  return {
    activeMode: (row.activeMode as StripeMode | null) ?? null,
    test: {
      configured: row.testSecretKeyCiphertext !== null,
      lastFour: row.testSecretKeyLastFour,
      savedAt: row.testSavedAt ? row.testSavedAt.toISOString() : null,
    },
    live: {
      configured: row.liveSecretKeyCiphertext !== null,
      lastFour: row.liveSecretKeyLastFour,
      savedAt: row.liveSavedAt ? row.liveSavedAt.toISOString() : null,
    },
  };
}

export async function saveStripeCredential(mode: StripeMode, secretKey: string, actor: CatalogActor): Promise<void> {
  const key = getEncryptionKey();
  const { ciphertext, iv, tag } = encryptBuffer(secretKey, key);
  const lastFour = secretKey.slice(-4);
  const now = new Date();

  const before = await getStripeCredentialStatus();
  const wasConfigured = mode === 'test' ? before.test.configured : before.live.configured;

  await prisma.$transaction([
    prisma.stripeOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        ...(mode === 'test'
          ? {
              testSecretKeyCiphertext: ciphertext,
              testSecretKeyIv: iv,
              testSecretKeyTag: tag,
              testSecretKeyLastFour: lastFour,
              testSavedAt: now,
            }
          : {
              liveSecretKeyCiphertext: ciphertext,
              liveSecretKeyIv: iv,
              liveSecretKeyTag: tag,
              liveSecretKeyLastFour: lastFour,
              liveSavedAt: now,
            }),
      },
      update:
        mode === 'test'
          ? {
              testSecretKeyCiphertext: ciphertext,
              testSecretKeyIv: iv,
              testSecretKeyTag: tag,
              testSecretKeyLastFour: lastFour,
              testSavedAt: now,
            }
          : {
              liveSecretKeyCiphertext: ciphertext,
              liveSecretKeyIv: iv,
              liveSecretKeyTag: tag,
              liveSecretKeyLastFour: lastFour,
              liveSavedAt: now,
            },
    }),
    prisma.stripeCatalogAudit.create({
      data: {
        action: wasConfigured ? 'credential_rotated' : 'credential_saved',
        // Never the key or ciphertext — only non-sensitive metadata.
        before: { mode, configured: wasConfigured },
        after: { mode, configured: true, lastFour },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateStripeCredentialCache();
}

export async function setActiveStripeMode(mode: StripeMode, actor: CatalogActor): Promise<void> {
  const before = await getOrCreateCredentialRow();

  await prisma.$transaction([
    prisma.stripeOperatorCredential.update({
      where: { id: SINGLETON_ID },
      data: { activeMode: mode },
    }),
    prisma.stripeCatalogAudit.create({
      data: {
        action: 'active_mode_changed',
        before: { activeMode: before.activeMode },
        after: { activeMode: mode },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateStripeCredentialCache();
}

interface CachedSecret {
  mode: StripeMode;
  key: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: CachedSecret | null = null;
let warnedEnvFallback = false;

/**
 * Resolves the Stripe secret key currently in effect: the DB-stored
 * credential for the active mode if one has been saved and activated,
 * else STRIPE_SECRET_KEY from the environment (pre-migration fallback,
 * or a fresh environment with nothing pasted yet).
 *
 * Cached in-module with a 30s TTL — resolving requires a DB round-trip
 * plus a decrypt, and this is called on every Stripe API call site.
 * invalidateStripeCredentialCache() clears it immediately on the
 * instance that performed a save/rotate/mode-change; the TTL bounds
 * staleness on other warm serverless instances.
 */
export async function resolveActiveStripeSecret(): Promise<{ mode: StripeMode; key: string } | null> {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { mode: cached.mode, key: cached.key };
  }

  if (isDatabaseConfigured) {
    const row = await getOrCreateCredentialRow();
    const mode = row.activeMode as StripeMode | null;
    if (mode === 'test' && row.testSecretKeyCiphertext && row.testSecretKeyIv && row.testSecretKeyTag) {
      const key = decryptBuffer(
        { ciphertext: row.testSecretKeyCiphertext, iv: row.testSecretKeyIv, tag: row.testSecretKeyTag },
        getEncryptionKey(),
      );
      cached = { mode, key, cachedAt: Date.now() };
      return { mode, key };
    }
    if (mode === 'live' && row.liveSecretKeyCiphertext && row.liveSecretKeyIv && row.liveSecretKeyTag) {
      const key = decryptBuffer(
        { ciphertext: row.liveSecretKeyCiphertext, iv: row.liveSecretKeyIv, tag: row.liveSecretKeyTag },
        getEncryptionKey(),
      );
      cached = { mode, key, cachedAt: Date.now() };
      return { mode, key };
    }
  }

  const envKey = process.env.STRIPE_SECRET_KEY;
  if (envKey) {
    if (!warnedEnvFallback) {
      warnedEnvFallback = true;
      console.warn(
        '[stripe-credentials] No active Stripe credential saved in the database — falling back to STRIPE_SECRET_KEY from the environment. Save a key at /admin/portal/settings/billing to stop seeing this.',
      );
    }
    const mode: StripeMode = envKey.startsWith('sk_live_') ? 'live' : 'test';
    cached = { mode, key: envKey, cachedAt: Date.now() };
    return { mode, key: envKey };
  }

  return null;
}

export function invalidateStripeCredentialCache(): void {
  cached = null;
}
