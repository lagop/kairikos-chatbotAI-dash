import { expect } from '@playwright/test';
import { portalFixture as test } from '../fixtures/portal';

test.describe('Portal header — profile + logout (KAIA-2878)', () => {
  test('header shows the profile trigger with the signed-in email', async ({ page, clientA }) => {
    await page.goto('/portal/dashboard');

    const trigger = page.locator('[data-testid="header-profile-trigger"]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(clientA.users[0].email);
  });

  test('profile popover reveals full email, company name, and a logout button', async ({ page, clientA }) => {
    await page.goto('/portal/dashboard');

    const details = page.locator('[data-testid="header-profile"]');
    await expect(details).toBeVisible();

    await details.locator('summary').click();

    const panel = page.locator('[data-testid="header-profile-panel"]');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-testid="header-profile-email-full"]')).toHaveText(
      clientA.users[0].email
    );
    await expect(panel).toContainText(clientA.companyName);

    const logout = page.locator('[data-testid="header-logout"]');
    await expect(logout).toBeVisible();
    await expect(logout).toContainText(/cerrar sesi[oó]n/i);
  });

  test('logout button clears the session and lands on /portal/login', async ({ page }) => {
    await page.goto('/portal/dashboard');

    const details = page.locator('[data-testid="header-profile"]');
    await expect(details).toBeVisible();
    await details.locator('summary').click();

    const logout = page.locator('[data-testid="header-logout"]');
    await expect(logout).toBeVisible();
    await logout.click();

    await page.waitForURL(/\/portal\/login/);
    await expect(page.locator('[data-testid="header-profile"]')).toHaveCount(0);
  });

  test('direct POST to /api/portal/logout clears cookies and redirects to login', async ({ request, page }) => {
    // Seed an authenticated session via the same portal path the app uses
    await page.goto('/portal/dashboard');

    const res = await request.post('/api/portal/logout', {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect([302, 303, 307]).toContain(res.status());
    const location = res.headers()['location'] ?? '';
    expect(location).toMatch(/\/portal\/login/);

    const setCookie = res.headers()['set-cookie'] ?? '';
    // At least one of the dev-marker cookies must be cleared.
    expect(
      /kairikos-portal-dev-session=;|kairikos-portal-operator=;|authjs\.session-token=;|next-auth\.session-token=;/i.test(
        setCookie
      )
    ).toBe(true);
  });
});