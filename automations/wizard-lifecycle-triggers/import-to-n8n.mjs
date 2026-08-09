// =============================================================================
// KAIA-1172 / AU-2 — programmatic n8n import helper
//
// Reads the two .api.json siblings in this folder, and POSTs each to
// the n8n REST API v1 `POST /workflows` endpoint, returning the new
// workflow id + versionId.
//
// Why .api.json and not .json?
//   The full export (`wizard-abandoned.json`, `config-review-overdue.json`)
//   is meant for the n8n UI's "Import from File" action, which accepts
//   the full shape including `tags`, `active`, `versionId`, `meta`, and
//   `pinData`. The REST API v1 create endpoint rejects those fields:
//     * `tags`, `active` are read-only on create
//     * `versionId` is server-assigned (must be a UUID the server mints)
//     * `meta`, `pinData` are accepted on update but not on create
//   The build script strips those fields into `*.api.json` so this
//   helper can POST them directly without further massaging.
//
// Required env vars:
//   N8N_BASE_URL  — e.g. https://n8n.srv1170607.hstgr.cloud
//   N8N_API_KEY   — the user's n8n personal access token
//
// Optional:
//   N8N_API_VERSION — default "v1"
//
// Usage:
//   N8N_BASE_URL=https://n8n.srv1170607.hstgr.cloud \
//   N8N_API_KEY=eyJ... \
//   node automations/wizard-lifecycle-triggers/import-to-n8n.mjs
//
// Exits 0 on success (both workflows created), 1 on any failure.
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FLOWS_DIR = __dirname;

const BASE = process.env.N8N_BASE_URL;
const KEY = process.env.N8N_API_KEY;
const VERSION = process.env.N8N_API_VERSION ?? 'v1';

if (!BASE || !KEY) {
  console.error('Missing required env vars: N8N_BASE_URL, N8N_API_KEY');
  process.exit(1);
}

const files = [
  'wizard-abandoned.api.json',
  'config-review-overdue.api.json',
];

let failures = 0;

for (const f of files) {
  const path = resolve(FLOWS_DIR, f);
  const body = JSON.parse(readFileSync(path, 'utf8'));
  const url = `${BASE.replace(/\/+$/, '')}/api/${VERSION}/workflows`;

  console.log(`POST ${url}  ←  ${f}`);
  console.log(`  name: ${body.name}  (${body.nodes.length} nodes)`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }

  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status}: ${parsed.message ?? text}`);
    failures += 1;
    continue;
  }
  console.log(`  ✓ id: ${parsed.id}`);
  console.log(`    versionId: ${parsed.versionId}`);
  console.log(`    active: ${parsed.active}  (use POST /workflows/${parsed.id}/activate to flip)`);
}

if (failures > 0) {
  console.error(`\nFAIL — ${failures} import(s) failed.`);
  process.exit(1);
}
console.log('\nOK — both flows imported. Use the activate endpoint when ready.');
