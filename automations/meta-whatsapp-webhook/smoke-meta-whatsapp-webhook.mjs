// =============================================================================
// Contract smoke test — Meta WhatsApp inbound webhook workflow.
//
// Asserts the generated JSON matches the contract this flow exists to
// satisfy: both webhook methods present at the right path, the HMAC
// verification and portal-route contract (URL + auth header) are wired
// as documented, and every node is reachable. Run after every
// build-flows.ts regeneration, same discipline as
// smoke-wizard-lifecycle-flows.mjs.
//
// Run: node automations/meta-whatsapp-webhook/smoke-meta-whatsapp-webhook.mjs
// Exits 0 on pass, 1 on any failed assertion (prints all failures, not
// just the first).
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flow = JSON.parse(readFileSync(resolve(__dirname, 'meta-whatsapp-webhook.json'), 'utf8'));

const failures = [];
function assert(cond, message) {
  if (!cond) failures.push(message);
}
function findNode(name) {
  return flow.nodes.find((n) => n.name === name);
}

// --- Shape -------------------------------------------------------------
assert(flow.active === false, 'workflow must import inactive — review before it goes live');
assert(flow.nodes.length === 16, `expected 16 nodes, got ${flow.nodes.length}`);

// --- Both webhook methods at the same path ------------------------------
const verifyTrigger = findNode('Webhook — Verify (GET)');
const eventsTrigger = findNode('Webhook — Events (POST)');
assert(verifyTrigger?.parameters?.httpMethod === 'GET', 'verify trigger must be GET');
assert(eventsTrigger?.parameters?.httpMethod === 'POST', 'events trigger must be POST');
assert(
  verifyTrigger?.parameters?.path === eventsTrigger?.parameters?.path,
  'GET and POST triggers must share one path — Meta gets a single webhook URL',
);
assert(eventsTrigger?.parameters?.options?.rawBody === true, 'POST trigger must capture rawBody for signature verification');

// --- Verification handshake echoes hub.challenge as PLAIN TEXT ---------
const respondChallenge = findNode('Respond — Challenge OK');
assert(respondChallenge?.parameters?.respondWith === 'text', 'challenge response must be plain text, not JSON');
assert(
  respondChallenge?.parameters?.responseBody?.includes("hub.challenge"),
  'challenge response must echo hub.challenge verbatim',
);

// --- Signature verification uses the right secret + header --------------
const verifySig = findNode('Verify Signature');
assert(verifySig?.parameters?.jsCode?.includes('META_APP_SECRET'), 'must verify against META_APP_SECRET');
assert(verifySig?.parameters?.jsCode?.includes('x-hub-signature-256'), 'must read the x-hub-signature-256 header');
assert(verifySig?.parameters?.jsCode?.includes('hmacSha256Hex'), 'must compute HMAC via the pure-JS implementation');
// Regression check for the exact bug found live: this n8n instance
// disallows `require('crypto')` in Code nodes (NODE_FUNCTION_ALLOW_BUILTIN),
// so the node must never depend on it.
assert(!verifySig?.parameters?.jsCode?.includes("require('crypto')"), "must NOT require('crypto') — disallowed on this n8n instance");
assert(!verifySig?.parameters?.jsCode?.includes('timingSafeEqual'), 'must NOT use crypto.timingSafeEqual — same disallowed-module reason, uses a hand-rolled constant-time loop instead');

// --- Portal route contract: URL + auth header ----------------------------
const callRecall = findNode('POST /api/internal/recall/whatsapp-reply');
const callChatbot = findNode('POST /api/internal/channels/whatsapp/message');
for (const [node, path] of [
  [callRecall, '/api/internal/recall/whatsapp-reply'],
  [callChatbot, '/api/internal/channels/whatsapp/message'],
]) {
  assert(node?.parameters?.url?.includes(path), `must POST to ${path}`);
  assert(node?.parameters?.url?.includes('$env.PORTAL_API_URL'), `${path} call must use $env.PORTAL_API_URL`);
  const headerNames = (node?.parameters?.headerParameters?.parameters ?? []).map((h) => h.name);
  assert(headerNames.includes('X-Kairikos-Internal-Key'), `${path} call must send X-Kairikos-Internal-Key`);
  const authHeader = (node?.parameters?.headerParameters?.parameters ?? []).find(
    (h) => h.name === 'X-Kairikos-Internal-Key',
  );
  assert(authHeader?.value === '={{ $env.PORTAL_API_KEY }}', `${path} call must use $env.PORTAL_API_KEY, not a literal`);
}

// --- Ordering: recall route tried before the chatbot fallback -----------
const recallHandled = findNode('Recall Handled?');
const recallHandledConn = flow.connections[recallHandled?.name]?.main ?? [];
assert(
  recallHandledConn[1]?.[0]?.node === callChatbot.name,
  'the chatbot conversation route must only be called when the recall route answers handled:false',
);

// --- Every node reachable -------------------------------------------------
const nodeNames = new Set(flow.nodes.map((n) => n.name));
const targets = new Set();
for (const conn of Object.values(flow.connections)) {
  for (const branch of conn.main) {
    for (const t of branch) {
      assert(nodeNames.has(t.node), `connection points at an unknown node: ${t.node}`);
      targets.add(t.node);
    }
  }
}
const triggerNames = new Set([verifyTrigger.name, eventsTrigger.name]);
for (const n of flow.nodes) {
  if (!triggerNames.has(n.name)) {
    assert(targets.has(n.name), `node is unreachable: ${n.name}`);
  }
}

// --- Report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${flow.nodes.length}-node meta-whatsapp-webhook flow matches its contract.`);
