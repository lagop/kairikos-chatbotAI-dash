// =============================================================================
// KAIA-1172 / AU-2 — contract smoke test for the two wizard-lifecycle n8n flows
//
// Asserts the structural contract of the two generated workflow JSONs:
//
//   1. wizard-abandoned.json          — every 6h
//   2. config-review-overdue.json     — hourly
//
// Each flow must:
//   * declare the correct cron schedule
//   * have 8 nodes in the documented order
//   * POST to /api/internal/<kind>/scan then /api/internal/<kind>/fire
//   * use the $env.PORTAL_API_URL / $env.PORTAL_API_KEY contract
//   * report to /api/internal/n8n-execution (KAIA-1073)
//   * wire every upstream node's `error` output into the report node
//   * be `active: false` (operator activates manually after import)
//
// This is a self-contained Node script — no external deps, no live server.
// It is the n8n-side counterpart to the Backend smoke that exercises the
// portal routes.
//
// Run:   node scripts/smoke-wizard-lifecycle-flows.mjs
// Exit:  0 on success, 1 on any failure.
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FLOWS_DIR = __dirname;

let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function loadFlow(name) {
  return JSON.parse(readFileSync(resolve(FLOWS_DIR, name), 'utf8'));
}

function assertFlow(file, expected) {
  console.log(`\n=== ${file} ===`);
  const f = loadFlow(file);

  assert(typeof f.name === 'string' && f.name.includes('KAIA-1172'), `name includes KAIA-1172 (got ${f.name})`);
  assert(Array.isArray(f.nodes), 'nodes is an array');
  assert(f.active === false, 'active === false (operator activates manually)');
  assert(f.meta && f.meta.linkedIssue === 'KAIA-1172', 'meta.linkedIssue === KAIA-1172');
  assert(f.meta && f.meta.executionCaptureIssue === 'KAIA-1073', 'meta.executionCaptureIssue === KAIA-1073');
  assert(Array.isArray(f.tags) && f.tags.some(t => t.name === 'kairikos'), 'tag: kairikos');
  assert(Array.isArray(f.tags) && f.tags.some(t => t.name === 'wizard-lifecycle'), 'tag: wizard-lifecycle');
  assert(Array.isArray(f.tags) && f.tags.some(t => t.name === `kind:${expected.kind}`), `tag: kind:${expected.kind}`);

  assert(f.nodes.length === 8, `8 nodes (got ${f.nodes.length})`);

  const trigger = f.nodes[0];
  assert(trigger.type === 'n8n-nodes-base.scheduleTrigger', 'node[0] is scheduleTrigger');
  const cron = trigger.parameters?.rule?.interval?.[0]?.expression;
  assert(cron === expected.cron, `cron === ${expected.cron} (got ${cron})`);

  const scanNode = f.nodes.find((n) => n.name.endsWith('— Scan'));
  assert(!!scanNode, 'has a — Scan node');
  assert(
    scanNode?.parameters?.url === `={{ $env.PORTAL_API_URL }}/api/internal/${expected.portalPath}/scan`,
    `scan url points to /api/internal/${expected.portalPath}/scan`,
  );
  assert(
    scanNode?.parameters?.headerParameters?.parameters?.some(
      (p) => p.name === 'X-Kairikos-Internal-Key' && p.value === '={{ $env.PORTAL_API_KEY }}',
    ),
    'scan uses $env.PORTAL_API_KEY (no hard-coded secret)',
  );
  assert(
    scanNode?.parameters?.options?.response?.response?.neverError === true,
    'scan has neverError=true (no cascade on transient portal failure)',
  );

  const fireNode = f.nodes.find((n) => n.name.startsWith('POST /api/internal/'));
  assert(!!fireNode, 'has a POST /api/internal/.../fire node');
  assert(
    fireNode?.parameters?.url === `={{ $env.PORTAL_API_URL }}/api/internal/${expected.portalPath}/fire`,
    `fire url points to /api/internal/${expected.portalPath}/fire`,
  );
  assert(
    fireNode?.parameters?.options?.retry?.maxTries === 3,
    'fire retries 3 times',
  );

  const buildNode = f.nodes.find((n) => n.name === 'Build Fire Payload');
  assert(!!buildNode, 'has a Build Fire Payload code node');
  assert(
    buildNode?.parameters?.jsCode?.includes('return [{'),
    'build code returns the expected payload envelope',
  );

  const reportNode = f.nodes.find((n) => n.name === 'Report Execution to Portal (KAIA-1073)');
  assert(!!reportNode, 'has a Report Execution to Portal (KAIA-1073) node');
  assert(
    reportNode?.parameters?.url === '={{ $env.PORTAL_API_URL }}/api/internal/n8n-execution',
    'report url points to /api/internal/n8n-execution',
  );
  const reportBody = reportNode?.parameters?.body || '';
  const referencesBuild = reportBody.includes("$('Build Fire Payload')");
  assert(referencesBuild, 'report body references Build Fire Payload for clientId resolution');

  // Every upstream I/O node (the trigger, the scan, the split, the
  // if, the build code, and the fire HTTP request) must wire its
  // `error` into the report node. The Log Result code node is the
  // final terminal — it only emits a `console.log` and a no-op
  // payload, so its `error` branch is intentionally left unconnected
  // (matches the AU-1 sibling convention in
  // automations/operator-notifications/{stuck,escalation}.json). This
  // is the cross-cutting KAIA-1073 guarantee.
  const reportId = reportNode.id;
  const logResultName = 'Log Result';
  for (const n of f.nodes) {
    if (n.id === reportId) continue;
    if (n.name === logResultName) continue;
    const conn = f.connections[n.id];
    if (!conn) {
      assert(false, `node ${n.name} has no connections entry`);
      continue;
    }
    const errorToReport = (conn.error || []).some((branch) => branch.some((t) => t.node === reportId));
    assert(errorToReport, `${n.name} error output → Report Execution`);
  }
  // Log Result sanity: must have a main connection into Report
  // Execution so a successful run is captured.
  const logNode = f.nodes.find((n) => n.name === logResultName);
  const logMainToReport = (f.connections[logNode.id]?.main?.[0] || []).some((t) => t.node === reportId);
  assert(logMainToReport, 'Log Result main output → Report Execution');
}

// KAIA-1177 / KAIA-1357: the `portalPath` field captures the actual
// portal URL segment (which lives on the Backend side, not in the
// n8n flow's `kind` tag). The `kind` is the n8n-side tag we use to
// route in n8n and to drive the build script's `meta.linkedIssue`.
// The two used to be the same string — the URL drift fix on
// KAIA-1357 split them. Keep them separate here so the next
// rename on either side is a one-line update.
assertFlow('wizard-abandoned.json', { kind: 'wizard-abandoned', portalPath: 'wizard-abandoned', cron: '0 */6 * * *' });
assertFlow('config-review-overdue.json', { kind: 'config-review-overdue', portalPath: 'review-overdue', cron: '0 * * * *' });

console.log(`\n=== Result ===`);
if (failures === 0) {
  console.log('OK — both wizard-lifecycle flows conform to the AU-2 contract.');
  process.exit(0);
} else {
  console.error(`FAIL — ${failures} contract assertion(s) failed.`);
  process.exit(1);
}
