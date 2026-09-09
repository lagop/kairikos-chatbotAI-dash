// =============================================================================
// Programmatic n8n import helper — Meta WhatsApp inbound webhook
//
// Reads meta-whatsapp-webhook.api.json and POSTs it to the n8n REST API v1
// `POST /workflows` endpoint, returning the new workflow id + versionId.
// Same shape as automations/wizard-lifecycle-triggers/import-to-n8n.mjs —
// see that file's header for why the .api.json (not the full .json) is
// what gets posted (the API create endpoint rejects `tags`/`active`/
// `versionId`/`meta`/`pinData`, which the full export includes for the
// n8n UI's "Import from File" instead).
//
// Required env vars:
//   N8N_BASE_URL  — e.g. https://n8n.srv1170607.hstgr.cloud
//   N8N_API_KEY   — your n8n personal access token
//
// Optional:
//   N8N_API_VERSION — default "v1"
//
// Usage:
//   N8N_BASE_URL=https://n8n.srv1170607.hstgr.cloud \
//   N8N_API_KEY=eyJ... \
//   node automations/meta-whatsapp-webhook/import-to-n8n.mjs
//
// After import, still needed before it does anything:
//   1. Set META_WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, PORTAL_API_URL,
//      PORTAL_API_KEY in n8n's own environment variables (Settings →
//      Environments, or however this n8n instance manages them) — the
//      workflow reads them via $env, it does not carry them.
//   2. Activate: POST /workflows/{id}/activate (this script does not
//      activate — same "review before it goes live" posture as the
//      wizard-lifecycle import).
//   3. Copy the ACTIVE webhook's public URL from the "Webhook — Verify
//      (GET)" node in the n8n editor — that is what goes in Meta's
//      "URL de devolución de llamada" field. The GET and POST triggers
//      share the same path, so one URL covers both.
//
// Exits 0 on success, 1 on failure.
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE = process.env.N8N_BASE_URL;
const KEY = process.env.N8N_API_KEY;
const VERSION = process.env.N8N_API_VERSION ?? 'v1';

if (!BASE || !KEY) {
  console.error('Missing required env vars: N8N_BASE_URL, N8N_API_KEY');
  process.exit(1);
}

const path = resolve(__dirname, 'meta-whatsapp-webhook.api.json');
const body = JSON.parse(readFileSync(path, 'utf8'));
const url = `${BASE.replace(/\/+$/, '')}/api/${VERSION}/workflows`;

console.log(`POST ${url}  ←  meta-whatsapp-webhook.api.json`);
console.log(`  name: ${body.name}  (${body.nodes.length} nodes)`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { message: text };
}

if (!res.ok) {
  console.error(`  ✗ HTTP ${res.status}: ${parsed.message ?? text}`);
  process.exit(1);
}

console.log(`  ✓ id: ${parsed.id}`);
console.log(`    versionId: ${parsed.versionId}`);
console.log(`    active: ${parsed.active}  (use POST /workflows/${parsed.id}/activate to flip)`);
console.log('\nOK — imported. Set the 4 env vars in n8n, activate, then copy the webhook URL into Meta.');
