import { test, expect } from '@playwright/test';
import { PortalTestFixtures } from '../fixtures/portal';

const T = test.extend<PortalTestFixtures>;

// KAIA-3921 — golden-path coverage for the client profile UI and the
// accessible logout action. The page lives at /portal/perfil and is
// gated by requirePortalSession() on the server, so these tests use
// the dev-mock session cookie set by the middleware.

T.describe('Client profile + logout', () => {
  T('renders the profile page with current user data', async ({ page }) => {
    await page.goto('/portal/perfil');

    await expect(page).toHaveTitle(/Mi perfil/);
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-contact-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-email"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-tier"]')).toBeVisible();
  });

  T('exposes canonical + OpenGraph meta tags for SEO hygiene', async ({ page }) => {
    await page.goto('/portal/perfil');

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /\/portal\/perfil$/);

    const ogTitle = page.locator('head meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute('content', /Mi perfil/);

    const ogDescription = page.locator('head meta[property="og:description"]');
    await expect(ogDescription).toHaveAttribute('content', /portal Kairikos/);
  });

  T('disables the submit button until the form is dirty', async ({ page }) => {
    await page.goto('/portal/perfil');

    const submit = page.locator('[data-testid="profile-submit"]');
    await expect(submit).toBeDisabled();

    const nameInput = page.locator('[data-testid="profile-contact-name"]');
    await nameInput.fill('Aurora Propietaria');
    await expect(submit).toBeEnabled();

    await nameInput.fill(await nameInput.inputValue().then((v) => v)); // unchanged
    await expect(submit).toBeDisabled();
  });

  T('shows a Spanish success message after a successful PATCH', async ({ page }) => {
    await page.goto('/portal/perfil');

    await page.route('**/api/portal/me', async (route, request) => {
      if (request.method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });

    const nameInput = page.locator('[data-testid="profile-contact-name"]');
    await nameInput.fill('Aurora Propietaria');

    await page.locator('[data-testid="profile-submit"]').click();

    const status = page.locator('[data-testid="profile-status"][data-status-kind="success"]');
    await expect(status).toBeVisible();
    await expect(status).toContainText(/guardados/i);
  });

  T('shows a Spanish error message when the API returns 400', async ({ page }) => {
    await page.goto('/portal/perfil');

    await page.route('**/api/portal/me', async (route, request) => {
      if (request.method() === 'PATCH') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_body', detail: 'Revisa los datos.' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.locator('[data-testid="profile-contact-name"]').fill('Aurora Propietaria');
    await page.locator('[data-testid="profile-submit"]').click();

    const status = page.locator('[data-testid="profile-status"][data-status-kind="error"]');
    await expect(status).toBeVisible();
  });

  T('surfaces a logout button in the header for signed-in users', async ({ page }) => {
    await page.goto('/portal');

    const logout = page.locator('[data-testid="header-logout"]');
    await expect(logout).toBeVisible();
  });

  T('shows a Perfil link in the navigation and routes to /portal/perfil', async ({ page }) => {
    await page.goto('/portal');

    const profileLink = page.locator('[data-testid="header-profile-link"]').first();
    await expect(profileLink).toBeVisible();
    await profileLink.click();

    await expect(page).toHaveURL(/\/portal\/perfil$/);
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();
  });

  T('renders a Logout button on the profile page that signs the user out', async ({ page }) => {
    await page.goto('/portal/perfil');

    const logout = page.locator('[data-testid="profile-logout"]');
    await expect(logout).toBeVisible();
    await expect(logout).toContainText(/Cerrar sesi/i);

    await logout.click();

    await expect(page).toHaveURL(/\/portal\/login/);
  });
});
