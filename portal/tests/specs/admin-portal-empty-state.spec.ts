// portal/tests/specs/admin-portal-empty-state.spec.ts
//
// KAIA-13758 — guardrail for the `rows.length === 0` → `MOCK_*` fallback
// pattern across `/admin/portal/*` SSR pages.
//
// The four pages listed below must NOT render MOCK_* fixtures when the DB
// is configured and reachable (that's the mocks.spec.ts guardrail). When
// the DB is NOT configured (local `next dev` without DATABASE_URL) the
// fixtures MUST still surface so the operator smoke pass stays exercisable
// end-to-end.
//
// We split the two paths with a `shouldSkip()` so the test only runs in
// dev-mock mode and skips on staging (where `mocks.spec.ts` already covers
// the no-leak side). The set of pages mirrors the four in the issue:
//   * /admin/portal                                (list)
//   * /admin/portal/flows                          (flow health)
//   * /admin/portal/wizard-funnel                  (wizard funnel)
//   * /admin/portal/[clientId]/wizard              (per-client wizard)

import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:3001';

const ACME_ID = '00000000-0000-0000-0000-000000000001';
const GLOBEX_ID = '00000000-0000-0000-0000-000000000002';

// We only run this spec when the target is a local dev server (i.e. the
// dev-mock mode). On staging (project-fxidg.vercel.app) the DB is
// configured, so the MOCK_* fixtures never appear and the test would be
// false-positive by construction.
function shouldSkip(): boolean {
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(PORTAL_URL)) return false;
  if (/^https?:\/\/project-fxidg\.vercel\.app/.test(PORTAL_URL)) return true;
  return true;
}

const SKIP_REASON =
  'KAIA-13758 dev-mock guard only runs against a local `next dev` (no DATABASE_URL). Use `PORTAL_URL=http://localhost:3001`. The no-leak side is covered by tests/specs/mocks.spec.ts on staging.';

async function gotoAsOperator(
  page: import('@playwright/test').Page,
  path: string,
): Promise<void> {
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

test.describe('Admin portal dev-mock fallback is preserved (KAIA-13758)', () => {
  test.skip(shouldSkip(), SKIP_REASON);

  test('/admin/portal renders the dev-mock client fixtures in dev-mock mode', async ({ page }) => {
    // WP-06 — /admin/portal is now a permanent redirect to the surviving
    // /admin/portal/clients listing (client-row, not admin-client-row —
    // the testid the old duplicate page used no longer exists).
    await gotoAsOperator(page, '/admin/portal');
    await expect(page).toHaveURL(/\/admin\/portal\/clients$/);

    const rows = page.locator('[data-testid="client-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const body = await page.content();
    // The dev-mock fallback must surface both seeded fixtures. If the
    // fixtures are gone in dev-mock mode, an operator smoke run can no
    // longer exercise the list page without seeding a real tenant.
    expect(body).toContain('Acme Corp');
    expect(body).toContain('Globex Inc');
  });

  test('/admin/portal/flows renders the dev-mock flow-health fixtures in dev-mock mode', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows');

    const rows = page.locator('[data-testid="flow-health-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const body = await page.content();
    expect(body).toContain('Acme Corp');
    expect(body).toContain('Globex Inc');
  });

  test('/admin/portal/wizard-funnel renders the dev-mock client fixtures in dev-mock mode', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/wizard-funnel');

    const rows = page.locator('[data-testid="wizard-funnel-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const body = await page.content();
    expect(body).toContain('Acme Corp');
    expect(body).toContain('Globex Inc');
  });

  test('/admin/portal/[clientId]/wizard renders the dev-mock step matrix in dev-mock mode', async ({ page }) => {
    await gotoAsOperator(page, `/admin/portal/${ACME_ID}/wizard`);

    await expect(page.locator('[data-testid="admin-wizard-step-list"]')).toBeVisible();
    const steps = page.locator('[data-testid^="admin-wizard-step-row-"]');
    const count = await steps.count();
    expect(count).toBeGreaterThan(0);

    const body = await page.content();
    expect(body).toContain('Acme Corp');
  });

  test('/admin/portal/[clientId]/wizard dev-mock also handles the Globex fixture', async ({ page }) => {
    await gotoAsOperator(page, `/admin/portal/${GLOBEX_ID}/wizard`);

    await expect(page.locator('[data-testid="admin-wizard-step-list"]')).toBeVisible();
    const body = await page.content();
    expect(body).toContain('Globex Inc');
  });
});
