import { expect } from '@playwright/test';
import { portalFixture } from '../../fixtures/portal';

const test = portalFixture;

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const ACME_ID = '00000000-0000-0000-0000-000000000001';

async function gotoFirstClient(page: import('@playwright/test').Page): Promise<string> {
  await page.context().clearCookies();
  await page.goto(`${PORTAL_URL}/admin/login`);
  await page.waitForLoadState('networkidle');
  const emailInput = page.locator('input[name="email"], input[type="email"]');
  const passwordInput = page.locator('input[name="password"]');
  await emailInput.fill(process.env.OPS_STAGING_OPERATOR_EMAIL ?? 'ops-staging@kairikos.com');
  await passwordInput.fill(process.env.OPS_STAGING_OPERATOR_PASSWORD ?? '');
  await page.locator('[data-testid="login-submit"]').click();
  await page.waitForURL(/\/admin\/portal/, { timeout: 10000 });

  const firstClientLink = page.locator('table a[href^="/admin/portal/"]').first();
  const href = await firstClientLink.getAttribute('href');
  if (!href) {
    throw new Error('no client rows in /admin/portal/clients table');
  }
  const clientId = href.replace('/admin/portal/', '').split('?')[0];
  await page.goto(`${PORTAL_URL}/admin/portal/${clientId}`);
  await page.waitForLoadState('networkidle');
  return clientId;
}

test.describe('Admin Editor — goLiveAt', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFirstClient(page);
  });

  test('setting goLiveAt shows success toast', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-goLiveAt"]');
    await expect(input).toBeVisible();

    const futureDate = '2026-12-31';
    await input.fill(futureDate);
    await page.locator('[data-testid="operator-edit-goLiveAt-save"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/go-live/i);
  });

  test('submitting same goLiveAt value shows info toast', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-goLiveAt"]');
    const currentValue = await input.inputValue();
    if (!currentValue) {
      await input.fill('2026-06-15');
      await page.locator('[data-testid="operator-edit-goLiveAt-save"]').click();
      await page.waitForTimeout(1000);
    }

    const sameValue = await page.locator('[data-testid="operator-edit-goLiveAt"]').inputValue();
    await page.locator('[data-testid="operator-edit-goLiveAt-save"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/ya est.+(actualizad)/i);
  });
});
