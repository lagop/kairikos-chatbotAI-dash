import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:3001';
const ACME_ID = '00000000-0000-0000-0000-000000000001';
const GLOBEX_ID = '00000000-0000-0000-0000-000000000002';

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

test.describe('Admin Flow-Health Dashboard', () => {
  test('@smoke operator can see the flow-health table at /admin/portal/flows', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows');

    await expect(page).toHaveURL(/\/admin\/portal\/flows$/);
    await expect(page.locator('[data-testid="flow-health-table"]')).toBeVisible();
    const rows = page.locator('[data-testid="flow-health-row"]');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('@smoke flow-health page shows stuck and failed filters', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows');

    const filterBar = page.locator('[data-testid="flow-filter-bar"]');
    await expect(filterBar).toBeVisible();
    await expect(filterBar.locator('[data-testid="flow-filter-all"]')).toBeVisible();
    await expect(filterBar.locator('[data-testid="flow-filter-stuck"]')).toBeVisible();
    await expect(filterBar.locator('[data-testid="flow-filter-failed"]')).toBeVisible();
  });

  test('@smoke stuck filter shows only clients with >3 days since last milestone', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows?filter=stuck');

    const rows = page.locator('[data-testid="flow-health-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const stuck = await rows.nth(i).getAttribute('data-stuck');
      expect(stuck).toBe('true');
    }
  });

  test('@smoke failed filter shows only clients with a recent n8n failure', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows?filter=failed');

    const rows = page.locator('[data-testid="flow-health-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const status = await rows.nth(i).getAttribute('data-n8n-status');
      expect(status).toBe('failed');
    }
  });

  test('@smoke operator can open a client flow view from the dashboard', async ({ page }) => {
    await gotoAsOperator(page, '/admin/portal/flows');

    const firstRow = page.locator('[data-testid="flow-health-row"]').first();
    const clientId = await firstRow.getAttribute('data-client-id');
    expect(clientId).toBeTruthy();

    await page.locator('[data-testid="flow-row-open"]').first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/portal/${clientId}\\?tab=flow`));

    await expect(page.locator('[data-testid="flow-history-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="flow-n8n-section"]')).toBeVisible();
  });

  test('@smoke per-client flow view shows timeline + n8n executions for an Acme client', async ({ page }) => {
    await gotoAsOperator(page, `/admin/portal/${ACME_ID}?tab=flow`);

    await expect(page.locator('[data-testid="flow-history-section"]')).toBeVisible();
    const items = page.locator('[data-testid="flow-history-item"]');
    expect(await items.count()).toBeGreaterThan(0);
  });

  test('@smoke per-client flow view surfaces a recent n8n failure for a Globex client', async ({ page }) => {
    await gotoAsOperator(page, `/admin/portal/${GLOBEX_ID}?tab=flow`);

    await expect(page.locator('[data-testid="flow-n8n-section"]')).toBeVisible();
    const failed = page.locator('[data-testid="flow-n8n-execution"][data-status="failed"]');
    expect(await failed.count()).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="flow-n8n-error"]').first()).toBeVisible();
  });

  test('@smoke non-operator request to /admin/portal/flows redirects to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/admin/portal/flows');
    await expect(page).toHaveURL(/\/portal\/login/);
  });
});
