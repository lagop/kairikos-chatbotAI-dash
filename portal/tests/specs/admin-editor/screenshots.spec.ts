import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';

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
  if (!href) throw new Error('no client rows');
  const clientId = href.replace('/admin/portal/', '').split('?')[0];
  await page.goto(`${PORTAL_URL}/admin/portal/${clientId}`);
  await page.waitForLoadState('networkidle');
  return clientId;
}

test.describe('Editor screenshots @visual', () => {
  test('desktop-1280 editor visible', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoFirstClient(page);
    await expect(page.locator('[data-testid="operator-editor"]')).toBeVisible();
    await page.screenshot({ path: 'screenshots/editor-final-1280.png', fullPage: true });
  });

  test('mobile-375 editor visible', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoFirstClient(page);
    await expect(page.locator('[data-testid="operator-editor"]')).toBeVisible();
    await page.screenshot({ path: 'screenshots/editor-final-375.png', fullPage: true });
  });
});