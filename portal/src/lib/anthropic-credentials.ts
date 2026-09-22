import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// Operator-managed Anthropic credential, saved through
// /admin/portal/settings/anthropic instead of only ever living in
// ANTHROPIC_API_KEY on the VPS .env.
//
// Same shape as twilio-credentials.ts (singleton row, 30s resolve cache,
// env fallback for the key). One real difference: baseUrl/model aren't
// paired secrets like Twilio's accountSid/authToken — they're plain
// configuration stored alongside the key because they're entered in the
// same form, not because they need the same protection.
//
// This ONE credential feeds FIVE call sites (chatbot-reply-ai.ts,
// lead-classification-ai.ts, review-reply-ai.ts, conversation-summary-ai.ts,
// seo-content-ai.ts). Each keeps its own ANTHROPIC_<FEATURE>_MODEL env
// override with priority over this row's `model` — narrowing one feature
// to a cheaper/different model doesn't require touching the shared
// credential. `apiKey` and `baseUrl` have no such per-feature override;
// there's exactly one Anthropic account and one endpoint for the whole
// portal.
// =============================================================================

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Singleton row — fixed id so getOrCreateCredentialRow() is a plain
// upsert, never a query that could race into two rows. Distinct from
// every other *OperatorCredential's SINGLETON_ID so a bug can never read
// the wrong table's row by coincidence of id.
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000f3';

function getEncryptionKey(): Buffer {
  return parseHexKey('ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY', process.env.ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY);
}

async function getOrCreateCredentialRow() {
  return prisma.anthropicOperatorCredential.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

export interface AnthropicCredentialStatus {
  configured: boolean;
  apiKeyLastFour: string | null;
  savedAt: string | null;
  // Not secret — shown in full, never masked. null means "using the
  // built-in default", not "unset".
  baseUrl: string | null;
  model: string | null;
}

/** Masked status for the settings UI — never decrypts anything. */
export async function getAnthropicCredentialStatus(): Promise<AnthropicCredentialStatus> {
  const row = await getOrCreateCredentialRow();
  return {
    configured: row.apiKeyCiphertext !== null,
    apiKeyLastFour: row.apiKeyLastFour,
    savedAt: row.savedAt ? row.savedAt.toISOString() : null,
    baseUrl: row.baseUrl,
    model: row.model,
  };
}

export interface CredentialActor {
  operatorId: string;
  operatorEmail: string | null;
}

export async function saveAnthropicCredential(
  input: { apiKey: string; baseUrl: string | null; model: string | null },
  actor: CredentialActor,
): Promise<void> {
  const key = getEncryptionKey();
  const { ciphertext, iv, tag } = encryptBuffer(input.apiKey, key);
  const lastFour = input.apiKey.slice(-4);

  const before = await getAnthropicCredentialStatus();

  await prisma.$transaction([
    prisma.anthropicOperatorCredential.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        apiKeyCiphertext: ciphertext,
        apiKeyIv: iv,
        apiKeyTag: tag,
        apiKeyLastFour: lastFour,
        baseUrl: input.baseUrl,
        model: input.model,
        savedAt: new Date(),
      },
      update: {
        apiKeyCiphertext: ciphertext,
        apiKeyIv: iv,
        apiKeyTag: tag,
        apiKeyLastFour: lastFour,
        baseUrl: input.baseUrl,
        model: input.model,
        savedAt: new Date(),
      },
    }),
    prisma.anthropicCredentialAudit.create({
      data: {
        action: before.configured ? 'credential_rotated' : 'credential_saved',
        // Never the key or ciphertext — only non-sensitive metadata.
        before: { configured: before.configured, baseUrl: before.baseUrl, model: before.model },
        after: { configured: true, lastFour, baseUrl: input.baseUrl, model: input.model },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);

  invalidateAnthropicCredentialCache();
}

export interface AnthropicCredentials {
  apiKey: string;
  // Origin only (e.g. "https://api.anthropic.com") — callers append their
  // own path ("/v1/messages").
  baseUrl: string;
  // The operator-configured default. Each call site still applies its own
  // ANTHROPIC_<FEATURE>_MODEL env override on top of this — see this
  // file's header comment.
  model: string;
}

interface CachedCredential extends AnthropicCredentials {
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: CachedCredential | null = null;
let warnedEnvFallback = false;

/**
 * Resolves the Anthropic config currently in effect: the DB-stored key if
 * one has been saved, else ANTHROPIC_API_KEY from the environment
 * (pre-migration fallback, or a fresh environment with nothing pasted
 * yet). baseUrl/model resolve DB-first, then the built-in default —
 * there's no legacy env var for either (they're new with this
 * credential), so there's no third fallback layer to check.
 *
 * Cached in-module with a 30s TTL, same reasoning as
 * resolveActiveTwilioCredentials: this is called on every AI generation
 * across five different features, each a DB round-trip plus a decrypt
 * without the cache. invalidateAnthropicCredentialCache() clears it
 * immediately on the instance that performed a save; the TTL bounds
 * staleness on other warm serverless instances.
 */
export async function resolveActiveAnthropicCredentials(): Promise<AnthropicCredentials | null> {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    const { cachedAt: _cachedAt, ...credentials } = cached;
    return credentials;
  }

  const row = isDatabaseConfigured ? await getOrCreateCredentialRow() : null;

  let apiKey: string | null = null;
  if (row?.apiKeyCiphertext && row.apiKeyIv && row.apiKeyTag) {
    apiKey = decryptBuffer({ ciphertext: row.apiKeyCiphertext, iv: row.apiKeyIv, tag: row.apiKeyTag }, getEncryptionKey());
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    if (!warnedEnvFallback) {
      warnedEnvFallback = true;
      console.warn(
        '[anthropic-credentials] No Anthropic credential saved in the database — falling back to ANTHROPIC_API_KEY from the environment. Save one at /admin/portal/settings/anthropic to stop seeing this.',
      );
    }
  }
  if (!apiKey) return null;

  const credentials: AnthropicCredentials = {
    apiKey,
    baseUrl: row?.baseUrl ?? DEFAULT_BASE_URL,
    model: row?.model ?? DEFAULT_MODEL,
  };
  cached = { ...credentials, cachedAt: Date.now() };
  return credentials;
}

export function invalidateAnthropicCredentialCache(): void {
  cached = null;
}
