import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// Generic encrypted storage for the operator's own third-party API keys,
// pasted at /admin/portal/settings/integrations — same pattern as
// stripe-credentials.ts (AES-256-GCM, decrypted at call time), with its
// own dedicated encryption key so a compromise of one credential class
// never exposes another. See schema.prisma's IntegrationCredential
// comment for why this is a separate model from OperatorSettings
// (KAIA-1106), which deliberately never stores a secret value.
//
// One row per `toolKey` rather than Stripe's singleton-with-two-modes
// shape — a plain API key has no test/live duality to model.
// =============================================================================

export interface IntegrationActor {
  // Null for the legacy KAIA_OPERATOR_API_KEY header path
  // (operator-session.ts's authenticateAdminRequest returns the
  // placeholder id 'legacy', not a real Operator row) — the audit FK is
  // nullable specifically so that path still records an event.
  operatorId: string | null;
  operatorEmail: string | null;
}

export interface IntegrationCredentialStatus {
  configured: boolean;
  lastFour: string | null;
  savedAt: string | null;
  // Cleartext, unlike lastFour — null for a single-secret tool (google_places).
  clientId: string | null;
}

function getEncryptionKey(): Buffer {
  return parseHexKey('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getIntegrationCredentialStatus(toolKey: string): Promise<IntegrationCredentialStatus> {
  const row = await prisma.integrationCredential.findUnique({ where: { toolKey } });
  return {
    configured: row !== null,
    lastFour: row?.secretLastFour ?? null,
    savedAt: row?.savedAt ? row.savedAt.toISOString() : null,
    clientId: row?.clientId ?? null,
  };
}

export async function saveIntegrationCredential(
  toolKey: string,
  displayName: string,
  secretValue: string,
  actor: IntegrationActor,
  clientId?: string,
): Promise<void> {
  const key = getEncryptionKey();
  const { ciphertext, iv, tag } = encryptBuffer(secretValue, key);
  const lastFour = secretValue.slice(-4);
  const now = new Date();

  const existing = await prisma.integrationCredential.findUnique({ where: { toolKey } });

  await prisma.$transaction(async (tx) => {
    const row = await tx.integrationCredential.upsert({
      where: { toolKey },
      create: {
        toolKey,
        displayName,
        clientId: clientId ?? null,
        secretCiphertext: ciphertext,
        secretIv: iv,
        secretTag: tag,
        secretLastFour: lastFour,
        savedAt: now,
      },
      update: {
        clientId: clientId ?? null,
        secretCiphertext: ciphertext,
        secretIv: iv,
        secretTag: tag,
        secretLastFour: lastFour,
        savedAt: now,
      },
    });
    await tx.integrationCredentialAudit.create({
      data: {
        credentialId: row.id,
        toolKey,
        action: existing ? 'credential_rotated' : 'credential_saved',
        // Never the key or ciphertext — only non-sensitive metadata.
        // clientId is cleartext (not a secret), safe to audit in full.
        before: existing
          ? { configured: true, lastFour: existing.secretLastFour, clientId: existing.clientId }
          : Prisma.JsonNull,
        after: { configured: true, lastFour, clientId: clientId ?? null },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    });
  });

  invalidateIntegrationCredentialCache(toolKey);
}

interface CachedSecret {
  value: string;
  clientId: string | null;
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CachedSecret>();

/**
 * Resolves the DB-stored secret for `toolKey`, or null if none has been
 * saved. Callers fall back to their own env var when this returns null —
 * kept out of this function so it stays agnostic to which env var (if
 * any) a given toolKey's caller uses as a fallback.
 *
 * Cached in-module with a 30s TTL, same posture and reasoning as
 * resolveActiveStripeSecret(): this is called on every API request the
 * integration makes, and resolving it fresh every time would mean a DB
 * round-trip plus a decrypt per call.
 */
export async function resolveIntegrationSecret(toolKey: string): Promise<string | null> {
  const cached = await getCached(toolKey);
  return cached?.value ?? null;
}

/**
 * Resolves the DB-stored, cleartext client_id for `toolKey` — the public
 * half of an OAuth-client-style credential (google_business/google_seo/
 * google_ga4). Null for a single-secret tool (google_places) or when
 * nothing has been saved. Shares the same cache entry as
 * resolveIntegrationSecret since both come off the same row.
 */
export async function resolveIntegrationClientId(toolKey: string): Promise<string | null> {
  const cached = await getCached(toolKey);
  return cached?.clientId ?? null;
}

async function getCached(toolKey: string): Promise<CachedSecret | null> {
  const cached = cache.get(toolKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  if (!isDatabaseConfigured) return null;

  const row = await prisma.integrationCredential.findUnique({ where: { toolKey } });
  if (!row) return null;

  const value = decryptBuffer({ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag }, getEncryptionKey());
  const entry: CachedSecret = { value, clientId: row.clientId, cachedAt: Date.now() };
  cache.set(toolKey, entry);
  return entry;
}

export function invalidateIntegrationCredentialCache(toolKey: string): void {
  cache.delete(toolKey);
}
