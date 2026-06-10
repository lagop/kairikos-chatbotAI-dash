import { test, expect } from '@playwright/test';
import { PortalTestFixtures } from '../fixtures/portal';

const T = test.extend<PortalTestFixtures>();

test.describe('Dashboard', () => {
  test('dashboard renders without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/portal/dashboard');

    await expect(page).not.toHaveURL(/error|500|404/);
    expect(errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });

  test('dashboard shows client name for authenticated client', async ({ page, clientA }) => {
    await page.goto('/portal/dashboard');

    const clientName = page.locator(`text=${clientA.companyName}`);
    const isVisible = await clientName.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('dashboard shows onboarding status widget', async ({ page }) => {
    await page.goto('/portal/dashboard');

    const widget = page.locator('[data-testid="dashboard-onboarding-widget"], .onboarding-widget');
    const isVisible = await widget.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('dashboard shows recent conversations widget', async ({ page }) => {
    await page.goto('/portal/dashboard');

    const widget = page.locator('[data-testid="dashboard-recent-conversations"], .recent-conversations');
    const isVisible = await widget.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('unauthenticated request redirects to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/portal/dashboard');

    await expect(page).toHaveURL(/\/portal\/login/);
  });
});