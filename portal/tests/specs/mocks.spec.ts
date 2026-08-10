// portal/tests/specs/mocks.spec.ts
//
// KAIA-13753 — Structural guardrail for the `/admin/portal/**` tree.
//
// We have shipped two regressions of the same root cause: a render path
// reads `MOCK_*` fixtures directly with no `isBackendConfigured` gate, so
// production shows dev-mock data:
//   * KAIA-13680 — `/admin/portal/clients` list page.
//   * KAIA-13744 — `/admin/portal/[clientId]` `ChatbotStatusCard`.
//
// This file is the recurrence guard. It hits the most-touched `/admin/portal/**`
// SSR surfaces with an operator-key bypass and asserts the rendered HTML does
// NOT contain the seeded mock literals (`spc_acme_corp`, `142`, the `Acme Corp`
// fixture name, `qa-test-client-a@…`, etc.). If any assertion fires, the bug
// family has regressed and the next regression ticket (sibling of KAIA-13680 /
// KAIA-13744) must be opened.
//
// Skip conditions mirror the existing `admin-flows.spec.ts` pattern: the test
// only runs when `KAIA_OPERATOR_API_KEY` is set AND `PORTAL_URL` points at a
// real deploy (not localhost), so a local `next dev` with mocks active does
// not break this guard.

import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const OPERATOR_KEY = process.env.KAIA_OPERATOR_API_KEY ?? '';

// `cmsh9mzor00018zsgsfa97l6m` was the seeded staging client the operator used
// when re-opening KAIA-13259 (Clínica dental Orly). Allowing an env override
// keeps the test pointing at whatever row staging QA is currently using.
const REAL_CLIENT_ID = process.env.KAIA_13753_CLIENT_ID ?? 'cmsh9mzor00018zsgsfa97l6m';

// Mock literals sourced from `portal/src/lib/portal-data.ts` and
// `portal/src/lib/flow-health.ts`. Each entry is a regex matched against the
// raw SSR HTML body (case-sensitive, no regex flags). The set is intentionally
// permissive — a regression can surface any of these literals, so a single
// false-positive is preferred over a silent leak.
const MOCK_LITERALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // portal/src/lib/portal-data.ts:27-38 — MOCK_CLIENT.id / slug / companyName / email / chatbotSpaceId
  { name: 'MOCK_CLIENT.id (acme uuid)', pattern: /00000000-0000-0000-0000-000000000001/ },
  { name: 'MOCK_CLIENT.slug', pattern: /acme-corp/ },
  { name: 'MOCK_CLIENT.companyName', pattern: /Acme Corp/ },
  { name: 'MOCK_CLIENT.primaryContactEmail', pattern: /qa-test-client-a@kairikos\.com/ },
  { name: 'MOCK_CLIENT.stripeCustomerId', pattern: /cus_test_client_a/ },

  // portal/src/lib/portal-data.ts:306-317 — MOCK_SECONDARY_CLIENT
  { name: 'MOCK_SECONDARY_CLIENT.id', pattern: /00000000-0000-0000-0000-000000000002/ },
  { name: 'MOCK_SECONDARY_CLIENT.slug', pattern: /globex-inc/ },
  { name: 'MOCK_SECONDARY_CLIENT.companyName', pattern: /Globex Inc/ },

  // portal/src/lib/portal-data.ts:82-91 — MOCK_CHATBOT
  { name: 'MOCK_CHATBOT.spaceId', pattern: /spc_acme_corp/ },
  { name: 'MOCK_CHATBOT.goLiveDate', pattern: /29 de mayo de 2026/i },
  { name: 'MOCK_CHATBOT.last7Days.conversations', pattern: /\b142\b/ },
  { name: 'MOCK_CHATBOT.last7Days.fallbackRate', pattern: /\b8 ?%\b/ },
  { name: 'MOCK_CHATBOT.last7Days.escalationRate', pattern: /\b12 ?%\b/ },

  // portal/src/lib/flow-health.ts:104-153 — MOCK_N8N_EXECUTIONS
  { name: 'MOCK_N8N_EXECUTIONS.id (n8n_001)', pattern: /\bn8n_00[1-4]\b/ },
  { name: 'MOCK_N8N_EXECUTIONS Acme Corp reference', pattern: /Acme Corp/ },

  // portal/src/lib/flow-health.ts:155-207 — MOCK_FLOW_ACTIVITY labels
  { name: 'MOCK_FLOW_ACTIVITY T+14 revisión', pattern: /T\+14 revisi[oó]n/ },
  { name: 'MOCK_FLOW_ACTIVITY T+3 configuración inicial', pattern: /T\+3 configuraci[oó]n inicial/ },

  // portal/src/lib/portal-data.ts:501-503 — re-exports. Page rendering these
  // names is a structural regression (dev module identifiers leaking into SSR).
  { name: 'MOCK_TIMELINE re-export identifier', pattern: /MOCK_TIMELINE/ },
  { name: 'MOCK_BILLING_EXPORT re-export identifier', pattern: /MOCK_BILLING_EXPORT/ },
  { name: 'MOCK_CHATBOT_FROM_DATA re-export identifier', pattern: /MOCK_CHATBOT_FROM_DATA/ },
  { name: 'MOCK_CONVERSATIONS re-export identifier', pattern: /MOCK_CONVERSATIONS/ },
];

function shouldSkip(): boolean {
  if (!OPERATOR_KEY) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(PORTAL_URL)) return true;
  return false;
}

const SKIP_REASON =
  'KAIA-13753 SSR mocks guard requires PORTAL_URL pointing at a real deploy and KAIA_OPERATOR_API_KEY in env.';

async function fetchSsr(request: import('@playwright/test').APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path, {
    headers: { 'x-kaia-operator-key': OPERATOR_KEY },
    maxRedirects: 0,
  });
  // 200 = the SSR HTML rendered; 304 = cache hit. Both are acceptable for the
  // guard. Anything else (3xx redirect to /portal/login, 5xx, etc.) means the
  // operator key bypass failed and the test should fail loudly.
  if (res.status() !== 200 && res.status() !== 304) {
    throw new Error(
      `unexpected status ${res.status()} for ${path} — operator-key bypass may be broken`,
    );
  }
  return res.text();
}

function assertNoMockLiterals(name: string, body: string): void {
  for (const { name: literalName, pattern } of MOCK_LITERALS) {
    const match = body.match(pattern);
    expect(
      match,
      `[${name}] SSR HTML must not contain mock literal "${literalName}" (matched: ${JSON.stringify(
        match?.[0],
      )})`,
    ).toBeNull();
  }
}

test.describe('Admin portal SSR is free of MOCK_* fixtures (KAIA-13753)', () => {
  test.skip(shouldSkip(), SKIP_REASON);

  test('/admin/portal (list) renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, '/admin/portal');
    assertNoMockLiterals('/admin/portal', body);
  });

  test('/admin/portal/clients renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, '/admin/portal/clients');
    assertNoMockLiterals('/admin/portal/clients', body);
  });

  test('/admin/portal/flows renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, '/admin/portal/flows');
    assertNoMockLiterals('/admin/portal/flows', body);
  });

  test('/admin/portal/wizard-funnel renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, '/admin/portal/wizard-funnel');
    assertNoMockLiterals('/admin/portal/wizard-funnel', body);
  });

  test('/admin/portal/[realClientId] overview renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, `/admin/portal/${REAL_CLIENT_ID}`);
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}`, body);
  });

  test('/admin/portal/[realClientId]?tab=flow renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, `/admin/portal/${REAL_CLIENT_ID}?tab=flow`);
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}?tab=flow`, body);
  });

  test('/admin/portal/[realClientId]/wizard renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, `/admin/portal/${REAL_CLIENT_ID}/wizard`);
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}/wizard`, body);
  });
});