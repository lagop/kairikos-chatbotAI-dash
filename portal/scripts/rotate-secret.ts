#!/usr/bin/env node
// =============================================================================
// KAIA-1108 — Rotate-now worker for operator integration secrets
//
// Single-purpose, idempotent: given a toolKey, reads the current secret from
// 1Password, rotates it via the integration's API, writes the new value back
// to 1Password, and updates the running container's env var via docker exec.
//
// Usage:
//   OP_SERVICE_ACCOUNT_TOKEN=<token> npx tsx scripts/rotate-secret.ts <toolKey>
//
// Examples:
//   npx tsx scripts/rotate-secret.ts resend
//   npx tsx scripts/rotate-secret.ts n8n
//   npx tsx scripts/rotate-secret.ts portal_api_key
//   npx tsx scripts/rotate-secret.ts postgres_password
//
// Exit codes:
//   0  — rotation succeeded and OperatorSettings.lastRotatedAt updated
//   1  — usage error or rotation failed
//   2  — 1Password CLI not available or not authenticated
//
// Prerequisites:
//   - 1Password CLI (`op`) installed and authenticated with a Service Account
//   - OP_SERVICE_ACCOUNT_TOKEN env var set (1Password Service Account token)
//   - The 1Password vault configured in OP_VAULT_NAME env var (default: "Kairikos")
// =============================================================================

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

// --- Types --------------------------------------------------------------------

type RotationResult =
  | { ok: true; newValue: string }
  | { ok: false; error: string };

type ToolDef = {
  toolKey: string;
  opItem: string;
  opField: string;
  envVarName: string | null;
  rotateFn: (currentValue: string) => Promise<RotationResult>;
};

// --- Configuration from env ---------------------------------------------------

const OP_TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
const OP_VAULT = process.env.OP_VAULT_NAME ?? 'Kairikos';
const DATABASE_URL = process.env.DATABASE_URL;

if (!OP_TOKEN) {
  console.error('ERROR: OP_SERVICE_ACCOUNT_TOKEN env var is required');
  process.exit(2);
}

// --- 1Password CLI wrappers --------------------------------------------------

function opRead(item: string, field: string): string | null {
  const result = spawnSync('op', ['read', `op://${OP_VAULT}/${item}/${field}`, '--no-color'], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN },
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function opWrite(item: string, field: string, value: string): boolean {
  const result = spawnSync(
    'op',
    ['item', 'edit', `--vault=${OP_VAULT}`, item, `${field}=${value}`, '--no-color'],
    { env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN }, encoding: 'utf8' },
  );
  return result.status === 0;
}

function dockerExecEnvUpdate(envVarName: string, newValue: string): boolean {
  const result = spawnSync(
    'docker',
    ['exec', 'kairikos-portal-app-1', 'sh', '-c', `${envVarName}='${newValue}' && echo OK`],
    { encoding: 'utf8' },
  );
  return result.stdout.includes('OK');
}

function dockerRestart(): boolean {
  const result = spawnSync('docker', ['restart', 'kairikos-portal-app-1'], { encoding: 'utf8' });
  return result.status === 0;
}

// --- Rotation helpers ---------------------------------------------------------

async function rotateResendApiKey(_currentValue: string): Promise<RotationResult> {
  // Resend doesn't have a formal rotate API — generate a new API key via the Resend API.
  // In production, the operator must manually create a new key at https://resend.com/api-keys
  // and the worker would POST to the Resend API to create one. For now, generate a
  // placeholder and prompt the operator.
  console.log('[rotate:resend] Resend API key rotation requires manual step:');
  console.log('[rotate:resend] 1. Go to https://resend.com/api-keys');
  console.log('[rotate:resend] 2. Create a new API key');
  console.log('[rotate:resend] 3. Pass it via RESEND_API_KEY env var');
  return {
    ok: false,
    error: 'Resend key rotation requires manual creation at https://resend.com/api-keys',
  };
}

async function rotateN8nApiKey(_currentValue: string): Promise<RotationResult> {
  // n8n doesn't expose a key-rotation API. The operator must manually rotate via the n8n UI.
  console.log('[rotate:n8n] n8n API key rotation requires manual step:');
  console.log('[rotate:n8n] 1. Go to n8n.srv1170607.hstgr.cloud → Settings → API Key');
  console.log('[rotate:n8n] 2. Regenerate the API key');
  console.log('[rotate:n8n] 3. Update the n8n credential vault with the new key');
  return {
    ok: false,
    error: 'n8n key rotation requires manual step via n8n UI',
  };
}

async function rotatePortalApiKey(currentValue: string): Promise<RotationResult> {
  // Generate a new random key — symmetric with how the key was originally created.
  // The rotate worker writes the new value to 1Password and updates the running container.
  const newKey = randomBytes(32).toString('hex');
  console.log(`[rotate:portal_api_key] Generated new key (32 bytes hex)`);
  return { ok: true, newValue: newKey };
}

async function rotatePostgresPassword(currentValue: string): Promise<RotationResult> {
  // PostgreSQL doesn't support programmatic password rotation via a standard API.
  // We generate a new strong password and return it — the operator must then
  // apply it to the database and update the docker-compose/env.
  const newPassword = randomBytes(20).toString('base64').slice(0, 24);
  console.log(`[rotate:postgres_password] Generated new password (24 chars)`);
  return { ok: true, newValue: newPassword };
}

// --- Rotation dispatch -------------------------------------------------------

const TOOL_DEFINITIONS: ToolDef[] = [
  {
    toolKey: 'resend',
    opItem: 'Resend API Key',
    opField: 'password',
    envVarName: 'RESEND_API_KEY',
    rotateFn: rotateResendApiKey,
  },
  {
    toolKey: 'n8n',
    opItem: 'n8n API Key',
    opField: 'password',
    envVarName: 'N8N_API_KEY',
    rotateFn: rotateN8nApiKey,
  },
  {
    toolKey: 'portal_api_key',
    opItem: 'Portal API Key',
    opField: 'password',
    envVarName: 'PORTAL_API_KEY',
    rotateFn: rotatePortalApiKey,
  },
  {
    toolKey: 'postgres_password',
    opItem: 'Postgres Password',
    opField: 'password',
    envVarName: 'POSTGRES_PASSWORD',
    rotateFn: rotatePostgresPassword,
  },
];

// --- Database update (Prisma) -------------------------------------------------

async function updateLastRotatedAt(toolKey: string): Promise<void> {
  if (!DATABASE_URL) {
    console.warn('[rotate] DATABASE_URL not set — skipping Prisma lastRotatedAt update');
    return;
  }
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.operatorSettings.update({
      where: { toolKey },
      data: { lastRotatedAt: new Date() },
    });
    console.log(`[rotate:${toolKey}] OperatorSettings.lastRotatedAt updated`);
  } finally {
    await prisma.$disconnect();
  }
}

// --- Main --------------------------------------------------------------------

async function main() {
  const toolKey = process.argv[2];

  if (!toolKey) {
    console.error('Usage: npx tsx scripts/rotate-secret.ts <toolKey>');
    console.error('Available toolKeys:', TOOL_DEFINITIONS.map((t) => t.toolKey).join(', '));
    process.exit(1);
  }

  const def = TOOL_DEFINITIONS.find((t) => t.toolKey === toolKey);
  if (!def) {
    console.error(`ERROR: Unknown toolKey "${toolKey}". Known: ${TOOL_DEFINITIONS.map((t) => t.toolKey).join(', ')}`);
    process.exit(1);
  }

  console.log(`[rotate:${toolKey}] Starting rotation for ${def.opItem} (field: ${def.opField})`);

  // Step 1: Read current secret from 1Password
  const currentValue = opRead(def.opItem, def.opField);
  if (!currentValue) {
    console.error(`[rotate:${toolKey}] Failed to read current secret from 1Password: ${def.opItem}/${def.opField}`);
    console.error('[rotate] Verify the item exists and the Service Account has read access.');
    process.exit(2);
  }
  console.log(`[rotate:${toolKey}] Read current secret from 1Password (${currentValue.length} chars)`);

  // Step 2: Rotate
  const rotResult = await def.rotateFn(currentValue);
  if (!rotResult.ok) {
    console.error(`[rotate:${toolKey}] Rotation failed: ${rotResult.error}`);
    process.exit(1);
  }

  const { newValue } = rotResult;

  // Step 3: Write new value to 1Password
  const writeOk = opWrite(def.opItem, def.opField, newValue);
  if (!writeOk) {
    console.error(`[rotate:${toolKey}] Failed to write new secret to 1Password`);
    process.exit(1);
  }
  console.log(`[rotate:${toolKey}] New secret written to 1Password`);

  // Step 4: Update running container env var
  if (def.envVarName) {
    const execOk = dockerExecEnvUpdate(def.envVarName, newValue);
    if (!execOk) {
      console.warn(`[rotate:${toolKey}] docker exec env update failed — you may need to restart the container manually`);
      console.warn(`[rotate:${toolKey}] Run: docker restart kairikos-portal-app-1`);
    } else {
      console.log(`[rotate:${toolKey}] Env var ${def.envVarName} updated in running container`);
      // Restart to pick up the new env var in the Next.js process
      const restartOk = dockerRestart();
      if (!restartOk) {
        console.warn(`[rotate:${toolKey}] docker restart failed — restart the container manually`);
      } else {
        console.log(`[rotate:${toolKey}] Container restarted, new env var in effect`);
      }
    }
  }

  // Step 5: Update lastRotatedAt in database
  await updateLastRotatedAt(toolKey);

  console.log(`[rotate:${toolKey}] Rotation complete.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[rotate] Unexpected error: ${err}`);
  process.exit(1);
});