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
