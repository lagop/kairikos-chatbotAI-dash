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
// only runs when `KAIA_PROBE_TOKEN` is set AND `PORTAL_URL` points at a
// real deploy (not localhost), so a local `next dev` with mocks active does
// not break this guard. (KAIA-13797 — replaces the previous
// `KAIA_OPERATOR_API_KEY` gate so the harness can replay this guard on
// staging without burning a per-ticket 10-min TTL.)
//
// WP-02 — this file had no `import { test, expect } from '@playwright/test'`
// and no top-level PORTAL_URL/QA_PROBE_TOKEN/OPERATOR_KEY declarations, so
// any Playwright command that collected it (including ones scoped to other
// files, since Playwright parses the whole testDir before filtering)
// crashed with a ReferenceError before ever reaching the skip check the
// comment above describes. Restored the same env-var pattern
// admin-flows.spec.ts already uses. Not restored: REAL_CLIENT_ID and
// MOCK_LITERALS, referenced only inside test bodies that this file's own
// `test.skip(shouldSkip(), ...)` gate never reaches without QA_PROBE_TOKEN
// set — reconstructing those from a comment alone risked asserting against
// the wrong client or the wrong mock strings.

import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:3001';
const QA_PROBE_TOKEN = process.env.QA_PROBE_TOKEN ?? '';
const OPERATOR_KEY = process.env.KAIA_OPERATOR_API_KEY ?? '';

function shouldSkip(): boolean {
  if (!QA_PROBE_TOKEN) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(PORTAL_URL)) return true;
  return false;
}

const SKIP_REASON =
  'KAIA-13753 SSR mocks guard requires PORTAL_URL pointing at a real deploy and QA_PROBE_TOKEN in env.';

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

// KAIA-13797 — AC2/AC3 route through the sidecar probe so the harness can
// replay this guard on staging without burning a 10-min
// KAIA_OPERATOR_API_KEY TTL. The probe renders the page server-side and
// returns the raw HTML, which the guard then asserts against. The
// existing `x-kaia-operator-key` path is kept for the other routes
// outside the AC2/AC3 scope.
async function fetchViaProbe(
  request: import('@playwright/test').APIRequestContext,
  path: string,
  tab?: string,
): Promise<string> {
  const qs = new URLSearchParams({ path });
  if (tab) qs.set('tab', tab);
  const res = await request.get(`/api/qa-probe?${qs.toString()}`, {
    headers: { 'x-qa-probe-token': QA_PROBE_TOKEN },
    maxRedirects: 0,
  });
  if (res.status() !== 200 && res.status() !== 304) {
    throw new Error(
      `unexpected probe status ${res.status()} for ${path} — qa-probe token or upstream may be broken`,
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

test.describe('@staging Admin portal SSR is free of MOCK_* fixtures (KAIA-13753)', () => {
  test.skip(shouldSkip(), SKIP_REASON);

  // WP-06 — /admin/portal no longer renders its own list; it's a
  // permanent redirect to /admin/portal/clients (the surviving page,
  // covered by the next test). Guard the redirect itself instead of
  // re-running the MOCK_* content check against a route with no content.
  test('/admin/portal redirects to /admin/portal/clients', async ({ request }) => {
    const res = await request.get('/admin/portal', {
      headers: { 'x-kaia-operator-key': OPERATOR_KEY },
      maxRedirects: 0,
    });
    expect([307, 308]).toContain(res.status());
    expect(res.headers()['location']).toContain('/admin/portal/clients');
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
    const body = await fetchViaProbe(request, `/admin/portal/${REAL_CLIENT_ID}`);
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}`, body);
  });

  test('/admin/portal/[realClientId]?tab=flow renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchViaProbe(request, `/admin/portal/${REAL_CLIENT_ID}`, 'flow');
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}?tab=flow`, body);
  });

  test('/admin/portal/[realClientId]/wizard renders no MOCK_* literals', async ({ request }) => {
    const body = await fetchSsr(request, `/admin/portal/${REAL_CLIENT_ID}/wizard`);
    assertNoMockLiterals(`/admin/portal/${REAL_CLIENT_ID}/wizard`, body);
  });
});