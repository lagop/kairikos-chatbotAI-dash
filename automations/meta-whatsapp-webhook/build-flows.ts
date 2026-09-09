// =============================================================================
// n8n workflow export generator — Meta WhatsApp inbound webhook
//
// Generates the workflow that receives Meta's Cloud API webhook (both the
// GET verification handshake and the POST message-event deliveries) and
// bridges it to the two portal routes that already implement the actual
// business logic (see portal/src/app/api/internal/recall/whatsapp-reply
// and .../channels/whatsapp/message) — this workflow does NOT duplicate
// that logic, it only authenticates Meta, extracts the message, and
// relays it, same "n8n interprets, portal decides" boundary as every
// other integration in this repo.
//
// Two branches on the same path (`meta-whatsapp`), split by HTTP method
// (n8n scopes a webhook registration by path+method independently, so two
// Webhook nodes at the same path is the normal way to do this):
//
//   GET  → Meta's one-time subscription handshake. Echo back
//          `hub.challenge` as PLAIN TEXT if `hub.verify_token` matches
//          META_WEBHOOK_VERIFY_TOKEN — otherwise 403. This is the ONLY
//          place in this flow needing a raw, non-JSON response body,
//          hence the explicit `respondToWebhook` node (the `lastNode`
//          auto-response mode used elsewhere in this repo's flows always
//          wraps output as JSON, which Meta will reject here).
//
//   POST → An actual event. Verify `X-Hub-Signature-256` (HMAC-SHA256 of
//          the RAW body with META_APP_SECRET — same mechanism, adapted
//          from the Tally-webhook HMAC verification code node in
//          automations/portal-internal-activity/build-flows.ts, which
//          already proved `require('crypto')` works in this n8n's Code
//          node). Only text messages are forwarded; status/delivery
//          receipts and other event types are acked and dropped. Tries
//          the recall digest-reply route FIRST; falls through to the
//          general chatbot conversation route only when it answers
//          `handled: false` — mirrors the ordering documented in
//          whatsapp-reply/route.ts's own header comment.
//
// UNVERIFIED AGAINST A REAL META APP OR A REAL N8N IMPORT — same standing
// caveat as every Meta integration built this cycle. The node shapes
// follow this repo's own already-proven conventions (see
// automations/wizard-lifecycle-triggers and
// automations/portal-internal-activity for the precedents), but the
// first real webhook delivery is the actual test this hasn't had.
//
// Output: 1 file in this folder (+ a `.api.json` sibling), importable via
// n8n → Workflows → Import from File, or via import-to-n8n.mjs.
//
// Run: npx tsx automations/meta-whatsapp-webhook/build-flows.ts
// =============================================================================

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEBHOOK_PATH = 'meta-whatsapp';
const idp = (suffix: string) => `kairikos-meta-whatsapp-${suffix}`;

// Pure-JS SHA-256 + HMAC-SHA256, no `require('crypto')` — see the
// "Verify Signature" node below for why. `Buffer` is a global in n8n's
// Code node sandbox (unaffected by the disallowed-modules restriction),
// so it's still used for base64/UTF-8 conversion; only the hashing
// primitive itself is hand-implemented. Verified bit-exact against
// Node's real `crypto.createHmac` for empty, short, and >1000-byte
// multi-block inputs — see this folder's README.
const PURE_JS_HMAC_SHA256_SOURCE = `
function sha256(bytes) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const bitLen = bytes.length * 8;
  const withOne = new Uint8Array(bytes.length + 1);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  let totalLen = withOne.length;
  while (totalLen % 64 !== 56) totalLen++;
  const padded = new Uint8Array(totalLen + 8);
  padded.set(withOne);
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0,h1,h2,h3,h4,h5,h6,h7].forEach((v, i) => outView.setUint32(i * 4, v, false));
  return out;
}
function hmacSha256(keyBytes, msgBytes) {
  const blockSize = 64;
  let key = keyBytes;
  if (key.length > blockSize) key = sha256(key);
  const padded = new Uint8Array(blockSize);
  padded.set(key);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) { ipad[i] = padded[i] ^ 0x36; opad[i] = padded[i] ^ 0x5c; }
  const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  const inner = sha256(concat(ipad, msgBytes));
  return sha256(concat(opad, inner));
}
function hmacSha256Hex(secretString, msgBuffer) {
  const keyBytes = Buffer.from(secretString, 'utf8');
  const digest = hmacSha256(keyBytes, msgBuffer);
  return Buffer.from(digest).toString('hex');
}
`.trim();

function buildFlow(): Record<string, unknown> {
  // ---- GET branch: Meta's verification handshake --------------------------
  const verifyWebhookTrigger = {
    id: idp('verify-trigger'),
    name: 'Webhook — Verify (GET)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [250, 160],
    webhookId: WEBHOOK_PATH,
    parameters: {
      httpMethod: 'GET',
      path: WEBHOOK_PATH,
      responseMode: 'responseNode',
      options: {},
    },
  };

  const checkVerifyToken = {
    id: idp('check-verify-token'),
    name: 'Check Verify Token',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.1,
    position: [470, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: idp('verify-token-condition'),
            operator: { type: 'string', operation: 'equals' },
            leftValue: "={{ $json.query['hub.verify_token'] }}",
            rightValue: '={{ $env.META_WEBHOOK_VERIFY_TOKEN }}',
          },
        ],
        combinator: 'and',
      },
    },
  };

  const respondChallenge = {
    id: idp('respond-challenge'),
    name: 'Respond — Challenge OK',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [690, 80],
    parameters: {
      respondWith: 'text',
      responseBody: "={{ $json.query['hub.challenge'] }}",
      options: {
        responseCode: 200,
        // n8n's respondToWebhook defaults to text/html for respondWith:'text'.
        // Meta's verification handshake expects a plain-text echo of
        // hub.challenge — found live when Meta's own validator rejected
        // the html-typed response.
        responseHeaders: {
          entries: [{ name: 'Content-Type', value: 'text/plain' }],
        },
      },
    },
  };

  const respondVerifyFailed = {
    id: idp('respond-verify-failed'),
    name: 'Respond — Verify Failed',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [690, 240],
    parameters: {
      respondWith: 'text',
      responseBody: 'Forbidden',
      options: { responseCode: 403 },
    },
  };

  // ---- POST branch: an actual event -----------------------------------------
  const eventsWebhookTrigger = {
    id: idp('events-trigger'),
    name: 'Webhook — Events (POST)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [250, 460],
    webhookId: WEBHOOK_PATH,
    parameters: {
      httpMethod: 'POST',
      path: WEBHOOK_PATH,
      responseMode: 'responseNode',
      // Raw body needed byte-for-byte for HMAC verification — a
      // re-serialized JSON.stringify of the parsed body would not
      // reliably match what Meta actually signed.
      options: { rawBody: true },
    },
  };

  const verifySignature = {
    id: idp('verify-signature'),
    name: 'Verify Signature',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [470, 460],
    parameters: {
      // Pure-JS SHA-256/HMAC-SHA256 — deliberately NOT `require('crypto')`.
      // Found live, against this exact n8n instance: Code nodes here run
      // with the built-in `crypto` module disallowed
      // (NODE_FUNCTION_ALLOW_BUILTIN, a server-level setting this
      // workflow has no way to change), so the natural implementation
      // fails at runtime with "Module 'crypto' is disallowed" — silently
      // skipping signature verification would have been far worse than a
      // loud failure, so this exists instead of a `require`. Verified
      // bit-exact against Node's real `crypto.createHmac` for empty,
      // short, and >1000-byte multi-block inputs before use — see
      // automations/meta-whatsapp-webhook/README.md's verification
      // section. `Buffer` itself is a global, not a `require`d module,
      // so it is unaffected by the same restriction and still used for
      // base64-decoding the raw body.
      //
      // Returns { valid, raw } rather than throwing on mismatch — a
      // webhook response needs a clean 403 here, not n8n's generic error
      // page, so the failure is branched explicitly with an IF node
      // below instead of relying on the workflow's error output.
      jsCode: PURE_JS_HMAC_SHA256_SOURCE + '\n' + [
        'const secret = $env.META_APP_SECRET;',
        "if (!secret) { throw new Error('META_APP_SECRET not configured'); }",
        "const header = $input.first().json.headers['x-hub-signature-256'] || '';",
        "const expectedPrefix = 'sha256=';",
        'const rawBuffer = $input.first().binary?.data?.data',
        "  ? Buffer.from($input.first().binary.data.data, 'base64')",
        "  : Buffer.from(JSON.stringify($input.first().json), 'utf8');",
        'const digest = hmacSha256Hex(secret, rawBuffer);',
        'const expected = expectedPrefix + digest;',
        '// Constant-time compare, implemented by hand — the equivalent',
        "// built-in comparison function lives in the disallowed 'crypto' module.",
        'let valid = header.length === expected.length;',
        'let diff = 0;',
        'for (let i = 0; i < expected.length; i++) {',
        '  diff |= (header.charCodeAt(i) || 0) ^ expected.charCodeAt(i);',
        '}',
        'valid = valid && diff === 0;',
        "return [{ json: { valid, body: JSON.parse(rawBuffer.toString('utf8')) } }];",
      ].join('\n'),
    },
  };

  const checkSignatureValid = {
    id: idp('check-signature-valid'),
    name: 'Check Signature Valid',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.1,
    position: [690, 460],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          {
            id: idp('signature-valid-condition'),
            operator: { type: 'boolean', operation: 'true' },
            leftValue: '={{ $json.valid }}',
          },
        ],
        combinator: 'and',
      },
    },
  };

  const respondBadSignature = {
    id: idp('respond-bad-signature'),
    name: 'Respond — Bad Signature',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [910, 320],
    parameters: {
      respondWith: 'text',
      responseBody: 'Forbidden',
      options: { responseCode: 403 },
    },
  };

  const extractMessage = {
    id: idp('extract-message'),
    name: 'Extract Message',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [910, 460],
    parameters: {
      // Meta's Cloud API webhook payload shape (documented, stable):
      //   entry[0].changes[0].value.metadata.phone_number_id
      //   entry[0].changes[0].value.messages[0].{from,type,text.body}
      // Meta also delivers status updates (sent/delivered/read) and
      // non-text message types (image, audio, ...) to the SAME webhook
      // — those must be acked, not forwarded, since the portal routes
      // this flow calls only understand a plain text reply.
      jsCode: [
        'const body = $json.body;',
        "const change = body?.entry?.[0]?.changes?.[0]?.value;",
        'const message = change?.messages?.[0];',
        "const isText = message && message.type === 'text' && message.text?.body;",
        'if (!isText) {',
        '  return [{ json: { hasMessage: false } }];',
        '}',
        'return [{',
        '  json: {',
        '    hasMessage: true,',
        '    phoneNumberId: change.metadata?.phone_number_id,',
        '    from: message.from,',
        '    text: message.text.body,',
        '  },',
        '}];',
      ].join('\n'),
    },
  };

  const hasTextMessage = {
    id: idp('has-text-message'),
    name: 'Has Text Message?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.1,
    position: [1130, 460],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          {
            id: idp('has-message-condition'),
            operator: { type: 'boolean', operation: 'true' },
            leftValue: '={{ $json.hasMessage }}',
          },
        ],
        combinator: 'and',
      },
    },
  };

  const respondNoMessage = {
    id: idp('respond-no-message'),
    name: 'Respond — No Message',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [1350, 320],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ status: "ignored" }) }}',
      options: { responseCode: 200 },
    },
  };

  const callRecallReply = {
    id: idp('call-recall-reply'),
    name: 'POST /api/internal/recall/whatsapp-reply',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1350, 460],
    parameters: {
      method: 'POST',
      url: '={{ $env.PORTAL_API_URL }}/api/internal/recall/whatsapp-reply',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Kairikos-Internal-Key', value: '={{ $env.PORTAL_API_KEY }}' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        '={{ JSON.stringify({ phoneNumberId: $json.phoneNumberId, from: $json.from, text: $json.text }) }}',
      options: {
        timeout: 15000,
        response: { response: { neverError: true } },
      },
    },
  };

  const recallHandled = {
    id: idp('recall-handled'),
    name: 'Recall Handled?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.1,
    position: [1570, 460],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          {
            id: idp('recall-handled-condition'),
            operator: { type: 'boolean', operation: 'true' },
            leftValue: '={{ $json.handled }}',
          },
        ],
        combinator: 'and',
      },
    },
  };

  const respondRecallHandled = {
    id: idp('respond-recall-handled'),
    name: 'Respond — Recall Handled',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [1790, 380],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ status: "ok" }) }}',
      options: { responseCode: 200 },
    },
  };

  const callChatbotMessage = {
    id: idp('call-chatbot-message'),
    name: 'POST /api/internal/channels/whatsapp/message',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1790, 540],
    parameters: {
      method: 'POST',
      url: '={{ $env.PORTAL_API_URL }}/api/internal/channels/whatsapp/message',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Kairikos-Internal-Key', value: '={{ $env.PORTAL_API_KEY }}' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      // Uses the ORIGINAL extracted fields (from the "Extract Message"
      // node), not the recall route's response — $('Node Name') reaches
      // back across the branch the same way the wizard-lifecycle flows'
      // "Report Execution" node already does in this repo.
      jsonBody:
        "={{ JSON.stringify({ phoneNumberId: $('Extract Message').item.json.phoneNumberId, from: $('Extract Message').item.json.from, text: $('Extract Message').item.json.text }) }}",
      options: {
        timeout: 15000,
        response: { response: { neverError: true } },
      },
    },
  };

  const respondChatbotHandled = {
    id: idp('respond-chatbot-handled'),
    name: 'Respond — Chatbot Handled',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [2010, 540],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ status: "ok" }) }}',
      options: { responseCode: 200 },
    },
  };

  return {
    name: 'Meta WhatsApp Inbound Webhook → Kairikos Portal',
    nodes: [
      verifyWebhookTrigger,
      checkVerifyToken,
      respondChallenge,
      respondVerifyFailed,
      eventsWebhookTrigger,
      verifySignature,
      checkSignatureValid,
      respondBadSignature,
      extractMessage,
      hasTextMessage,
      respondNoMessage,
      callRecallReply,
      recallHandled,
      respondRecallHandled,
      callChatbotMessage,
      respondChatbotHandled,
    ],
    connections: {
      [verifyWebhookTrigger.name]: { main: [[{ node: checkVerifyToken.name, type: 'main', index: 0 }]] },
      [checkVerifyToken.name]: {
        main: [
          [{ node: respondChallenge.name, type: 'main', index: 0 }],
          [{ node: respondVerifyFailed.name, type: 'main', index: 0 }],
        ],
      },
      [eventsWebhookTrigger.name]: { main: [[{ node: verifySignature.name, type: 'main', index: 0 }]] },
      [verifySignature.name]: { main: [[{ node: checkSignatureValid.name, type: 'main', index: 0 }]] },
      [checkSignatureValid.name]: {
        main: [
          [{ node: extractMessage.name, type: 'main', index: 0 }],
          [{ node: respondBadSignature.name, type: 'main', index: 0 }],
        ],
      },
      [extractMessage.name]: { main: [[{ node: hasTextMessage.name, type: 'main', index: 0 }]] },
      [hasTextMessage.name]: {
        main: [
          [{ node: callRecallReply.name, type: 'main', index: 0 }],
          [{ node: respondNoMessage.name, type: 'main', index: 0 }],
        ],
      },
      [callRecallReply.name]: { main: [[{ node: recallHandled.name, type: 'main', index: 0 }]] },
      [recallHandled.name]: {
        main: [
          [{ node: respondRecallHandled.name, type: 'main', index: 0 }],
          [{ node: callChatbotMessage.name, type: 'main', index: 0 }],
        ],
      },
      [callChatbotMessage.name]: { main: [[{ node: respondChatbotHandled.name, type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
    staticData: null,
    tags: [{ name: 'kairikos' }, { name: 'meta-whatsapp-webhook' }],
    active: false,
    pinData: {},
    versionId: '1.0.0',
    meta: {
      templateCredsSetupCompleted: false,
      linkedIssue: 'recall-meta-inbound-webhook',
    },
  };
}

function stripForApiCreate(flow: Record<string, unknown>) {
  const { name, nodes, connections, settings, staticData } = flow as {
    name: unknown;
    nodes: unknown;
    connections: unknown;
    settings: unknown;
    staticData: unknown;
  };
  return { name, nodes, connections, settings, staticData };
}

function main() {
  const flow = buildFlow();
  const out = resolve(__dirname, 'meta-whatsapp-webhook.json');
  writeFileSync(out, JSON.stringify(flow, null, 2));
  const nodeCount = (flow.nodes as unknown[]).length;
  console.log(`[build-flows] wrote meta-whatsapp-webhook.json (${nodeCount} nodes)`);

  const apiFlow = stripForApiCreate(flow);
  const apiOut = resolve(__dirname, 'meta-whatsapp-webhook.api.json');
  writeFileSync(apiOut, JSON.stringify(apiFlow, null, 2));
  console.log('[build-flows] wrote meta-whatsapp-webhook.api.json (API-create shape)');
  console.log('[build-flows] OK');
}

main();
