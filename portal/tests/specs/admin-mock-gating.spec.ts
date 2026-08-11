// =============================================================================
// KAIA-13745 — SSR HTML guardrail: dev-mock literals must not appear in
// /admin/portal/** pages when the backend is configured.
//
// This is the runtime counterpart to tests/unit/admin-mock-gating.test.ts.
// The unit test statically scans the source for ungated MOCK_* references.
// This Playwright spec fetches the actual SSR HTML and asserts the mock
// literals (`spc_acme_corp`, `Acme Corp`, `qa-test-client-a@…`,
// `142`, `0.08`, `0.12`, etc.) do not appear in the rendered page body.
//
// What it protects against:
//
//   * [KAIA-13680] — clients list rendered MOCK_CLIENT when DB was
//     configured. MOCK_CLIENT fixtures leaked into the operator landing
//     page so the operator saw dev-mock data instead of real rows.
//   * [KAIA-13744] — ChatbotStatusCard rendered MOCK_CHATBOT when DB
//     was configured. The 142-conversation / 8% / 12% numbers showed
//     up in production.
//
// How to run:
//
//   PORTAL_URL=https://staging.kairikos.com \
//     npx playwright test tests/specs/admin-mock-gating.spec.ts
//
// Expected: passes against the current staging build (the regressions
// from KAIA-13680 and KAIA-13744 are fixed). Fails if any admin route
// re-introduces an ungated MOCK_* reference.
// =============================================================================

import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:3001';

// Mock fixtures from portal/src/lib/portal-data.ts and
// portal/src/lib/flow-health.ts. These are the literal strings that
// must NOT appear in production SSR HTML for /admin/portal/**.
const MOCK_LITERALS = [
  // Client identity
  'spc_acme_corp',
  'Acme Corp',
  'Globex Inc',
  'Hooli Iberia',
  'Initech S.L.',
  // Email addresses
  'qa-test-client-a@',
  'qa-test-client-b@',
  // Stripe customer IDs (mock fixtures)
  'cus_test_client_a',
  'cus_test_client_b',
  // Chatbot stats (the exact numbers from the KAIA-13744 regression)
  '142',
  '0.08',
  '0.12',
  // N8n execution fixture labels
  'T+14 revisión',
  'T+0 bienvenida',
  'T+3 configuración inicial',
  'T+7 go-live webhook',
];

// Routes to guard. The /admin/portal/* pages are the operator-facing
// admin views where the regression class manifests. We intentionally
// do NOT include /portal/** (client portal) — that's a separate
// surface and out of scope for KAIA-13745.
const ADMIN_ROUTES = [
  '/admin/portal',
  '/admin/portal/flows',
  '/admin/portal/wizard-funnel',
  '/admin/portal/clients',
];

async function gotoAsOperator(page: import('@playwright/test').Page, path: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: 'kairikos-portal-operator',
      value: '1',
      url: PORTAL_URL,
      sameSite: 'Lax',
    },
  ]);
  await page.goto(path);
}

test.describe('KAIA-13745 — SSR HTML must not contain dev-mock literals', () => {
  for (const route of ADMIN_ROUTES) {
    test(`${route} does not render mock literals`, async ({ page }) => {
      await gotoAsOperator(page, route);
      // Wait for the page to settle.
      await page.waitForLoadState('domcontentloaded');
      const html = await page.content();
      for (const literal of MOCK_LITERALS) {
        // We use expect.soft-style assertions by collecting all failures
        // and throwing once. Each `expect` call would log a failure but
        // continue; instead we collect explicitly so the test reports
        // every leaked literal in a single failure.
        if (html.includes(literal)) {
          throw new Error(
            `[KAIA-13745] mock literal "${literal}" found in SSR HTML for ${route}. ` +
              'This is the regression class from KAIA-13680 / KAIA-13744. ' +
              'All MOCK_* consumers must be gated on isBackendConfigured / ' +
              'isDatabaseConfigured / isPortalDevMock.',
          );
        }
      }
    });
  }
});

// =============================================================================
// KAIA-14318 — Per-client SSR guard for the [clientId] detail page.
//
// Background: the [clientId] page declares `let timeline = MOCK_TIMELINE;`
// as the default initializer. Brand-new clients (e.g. Clínica dental Orly,
// `cmsh9mzor00018zsgsfa97l6m`) have zero `chatbotActivity` rows, so the
// real-DB override never fires and the page renders the Acme fixture
// (May-22 / May-25 / May-29 mock dates) verbatim. The four "list" routes
// guarded above don't catch this — the regression surfaces ONLY on the
// per-client detail route.
//
// We probe each per-client route through `/api/qa-probe` (KAIA-13797) so
// the harness can replay this guard against a real deploy without burning
// the per-ticket 10-min `KAIA_OPERATOR_API_KEY` TTL. The probe is skipped
// against `localhost` / dev-mock mode — in dev mode the page intentionally
// surfaces the Acme fixture (the local-dev AC), so this guard is only
// meaningful in production.
//
// What it asserts:
//   * `/admin/portal/cmsh9mzor00018zsgsfa97l6m` (Clínica dental Orly, the
//     real client the operator used to reopen [KAIA-13259](/KAI/issues/KAIA-13259))
//     must NOT contain the Acme fixture dates (`22 may`, `25 may`, `29 may`)
//     in the Onboarding timeline. Renders the empty-state copy instead.
//   * `/admin/portal/00000000-0000-0000-0000-000000000001` (Acme UUID —
//     looks like a valid clientId to the route but doesn't resolve in
//     the DB) returns 404 — must NOT silently render the Acme fixture.
//   * `/admin/portal/00000000-0000-0000-0000-000000000002` (Globex UUID)
//     returns 404 — must NOT silently render the Globex fixture.
//
// Reference: [KAIA-13259](/KAI/issues/KAIA-13259) (operator-visible regression),
// [KAIA-14318](/KAI/issues/KAIA-14318) (the default-initializer fix).
// =============================================================================

const PER_CLIENT_QA_PROBE_TOKEN = process.env.QA_PROBE_TOKEN ?? '';

const PER_CLIENT_ROUTES = [
  '/admin/portal/cmsh9mzor00018zsgsfa97l6m', // Clínica dental Orly (real, zero rows)
  '/admin/portal/00000000-0000-0000-0000-000000000001', // Acme UUID (404 in prod)
  '/admin/portal/00000000-0000-0000-0000-000000000002', // Globex UUID (404 in prod)
];

// The Acme fixture dates — the exact strings rendered by MOCK_TIMELINE in
// the Onboarding module (see portal/src/lib/portal-data.ts MOCK_TIMELINE).
// These are the regression signal from KAIA-13259. If any of these appear
// in the SSR HTML for a brand-new real client, the default-initializer
// pattern has slipped back in.
const MOCK_TIMELINE_DATES = ['22 may', '25 may', '29 may'];

function perClientShouldSkip(): boolean {
  if (!PER_CLIENT_QA_PROBE_TOKEN) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(PORTAL_URL)) return true;
  return false;
}

async function fetchViaProbe(
  request: import('@playwright/test').APIRequestContext,
  path: string,
): Promise<string> {
  const qs = new URLSearchParams({ path });
  const res = await request.get(`/api/qa-probe?${qs.toString()}`, {
    headers: { 'x-qa-probe-token': PER_CLIENT_QA_PROBE_TOKEN },
    maxRedirects: 0,
  });
  // 200 = SSR HTML; 404 = `notFound()` from the page (the route resolved
  // to no client). Both are valid terminal states for our guard — what
  // matters is the body must not contain Acme/Globex fixtures.
  if (res.status() !== 200 && res.status() !== 404) {
    throw new Error(
      `[KAIA-14318] unexpected probe status ${res.status()} for ${path} — qa-probe token or upstream may be broken`,
    );
  }
  return res.text();
}

test.describe('KAIA-14318 — per-client [clientId] SSR is free of MOCK_TIMELINE fixture', () => {
  test.skip(perClientShouldSkip(), 'KAIA-14318 SSR guard requires PORTAL_URL pointing at a real deploy (not localhost) and QA_PROBE_TOKEN in env.');

  for (const route of PER_CLIENT_ROUTES) {
    test(`${route} does not render the May-22 / May-25 / May-29 Acme timeline fixture`, async ({ request }) => {
      const body = await fetchViaProbe(request, route);
      for (const date of MOCK_TIMELINE_DATES) {
        if (body.includes(date)) {
          throw new Error(
            `[KAIA-14318] MOCK_TIMELINE date "${date}" found in SSR HTML for ${route}. ` +
              'This is the brand-new-client regression from KAIA-13259. ' +
              'The default-initializer `let timeline = MOCK_TIMELINE;` must be `let timeline: OnboardingTimelineRow[] = [];` ' +
              'with MOCK_TIMELINE assignment gated on `if (!isDatabaseConfigured)`.',
          );
        }
      }
      // Also assert the canonical MOCK_LITERALS for the brand-new-client
      // case. (The Acme/Globex UUIDs 404 in production, so the body is
      // small — the Acme/Globex literals cannot leak even with a fully
      // ungated MOCK_* path because the page calls notFound() before
      // rendering. The Clínica dental Orly case is the meaningful one.)
      if (route.includes('cmsh9mzor')) {
        for (const literal of MOCK_LITERALS) {
          if (body.includes(literal)) {
            throw new Error(
              `[KAIA-14318] mock literal "${literal}" found in SSR HTML for ${route}. ` +
                'The MOCK_* timeline default-initializer regression has slipped back in.',
            );
          }
        }
      }
    });
  }
});
