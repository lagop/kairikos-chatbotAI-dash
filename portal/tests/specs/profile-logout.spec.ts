import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { testClients } from '../fixtures/portal';

// KAIA-3921 / KAIA-4011 — golden-path coverage for the client profile
// UI, the accessible logout action, and the dev-mock auth contract.
//
// The page lives at /portal/perfil and is gated by
// requirePortalSession() on the server. Dev-mock activation goes
// through POST /api/portal/dev-session (KAIA-4011) which sets the
// active flag + dev-session + dev-email cookies; logout (server
// action) + DELETE /api/portal/dev-session clear them. The active
// flag is the gate: without it, the middleware never re-seeds the
// dev-mock session and requirePortalSession() redirects to
// /portal/login — restoring the unauth → 307 contract.

const DEV_SESSION_ACTIVE_COOKIE = 'kairikos-portal-dev-session-active';
const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const DEV_EMAIL_COOKIE = 'kairikos-portal-dev-email';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

async function activateDevMockSession(
  request: { post: (url: string, options?: { data?: unknown }) => Promise<{ ok: () => boolean; status: () => number }> },
  email: string,
) {
  const res = await request.post('/api/portal/dev-session', { data: { email } });
  if (!res.ok()) {
    throw new Error(`dev-mock activation failed: ${res.status()}`);
  }
}

async function clearDevMockSession(
  request: { delete: (url: string) => Promise<{ ok: () => boolean; status: () => number }> },
) {
  await request.delete('/api/portal/dev-session');
}

async function setDevMockCookies(context: BrowserContext, email: string) {
  const baseURL = 'http://localhost:3001';
  await context.addCookies([
    {
      name: DEV_SESSION_ACTIVE_COOKIE,
      value: '1',
      url: baseURL,
      sameSite: 'Lax',
    },
    {
      name: DEV_SESSION_COOKIE,
      value: '1',
      url: baseURL,
      sameSite: 'Lax',
    },
    {
      name: DEV_EMAIL_COOKIE,
      value: email,
      url: baseURL,
      sameSite: 'Lax',
    },
    {
      name: OPERATOR_COOKIE,
      value: '1',
      url: baseURL,
      sameSite: 'Lax',
    },
  ]);
}

test.describe('Client profile + logout', () => {
  test.beforeEach(async ({ context, request }) => {
    // KAIA-4011 — activate the dev-mock session through the
    // documented endpoint. This sets the active flag the middleware
    // requires to honor the dev-mock session on the next request,
    // and matches the live preview curl recipe in the issue
    // description.
    await activateDevMockSession(request, testClients.clientA.primaryContactEmail);
  });

  test('renders the profile page with current user data', async ({ page }) => {
    await page.goto('/portal/perfil');

    await expect(page).toHaveTitle(/Mi perfil/);
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-contact-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-email"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-tier"]')).toBeVisible();
  });

  test('exposes canonical + OpenGraph meta tags for SEO hygiene', async ({ page }) => {
    await page.goto('/portal/perfil');

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /\/portal\/perfil$/);

    const ogTitle = page.locator('head meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute('content', /Mi perfil/);

    const ogDescription = page.locator('head meta[property="og:description"]');
    await expect(ogDescription).toHaveAttribute('content', /portal Kairikos/);
  });

  test('disables the submit button until the form is dirty', async ({ page }) => {
    await page.goto('/portal/perfil');

    const submit = page.locator('[data-testid="profile-submit"]');
    await expect(submit).toBeDisabled();

    const nameInput = page.locator('[data-testid="profile-contact-name"]');
    await nameInput.fill('Aurora Propietaria');
    await expect(submit).toBeEnabled();

    // KAIA-4011 — re-fill the same value must re-disable the button.
    // Read the current value through the DOM so the test exercises
    // the same code path the QA verdict flagged (Playwright .fill()
    // with the same value).
    const current = await nameInput.inputValue();
    await nameInput.fill(current);
    await expect(submit).toBeDisabled();
  });

  test('shows a Spanish success message after a successful PATCH', async ({ page }) => {
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

  test('shows a Spanish error message when the API returns 400', async ({ page }) => {
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

  test('surfaces a logout button in the header for signed-in users', async ({ page }) => {
    await page.goto('/portal');

    const logout = page.locator('[data-testid="header-logout"]');
    await expect(logout).toBeVisible();
  });

  test('shows a Perfil link in the navigation and routes to /portal/perfil', async ({ page }) => {
    await page.goto('/portal');

    const profileLink = page.locator('[data-testid="header-profile-link"]').first();
    await expect(profileLink).toBeVisible();
    await profileLink.click();

    await expect(page).toHaveURL(/\/portal\/perfil$/);
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();
  });

  test('renders a Logout button on the profile page that signs the user out', async ({ page }) => {
    await page.goto('/portal/perfil');

    const logout = page.locator('[data-testid="profile-logout"]');
    await expect(logout).toBeVisible();
    await expect(logout).toContainText(/Cerrar sesi/i);

    await logout.click();

    await expect(page).toHaveURL(/\/portal\/login/);
  });

  test('reflects the seeded client email in the read-only profile field', async ({ page }) => {
    await page.goto('/portal/perfil');

    await expect(page.locator('[data-testid="profile-email"]')).toHaveValue(
      testClients.clientA.primaryContactEmail
    );
  });

  // KAIA-4011 — Finding C: back-navigation after logout must not
  // resurrect the seeded profile. The acceptance contract is "the
  // browser back button does not expose the previous authenticated
  // state". On the dev-mock preview this used to leak because the
  // middleware re-seeded the dev session on every fresh request.
  test('back-navigation after logout does not expose the seeded profile', async ({ page }) => {
    await page.goto('/portal/perfil');
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();

    const logout = page.locator('[data-testid="profile-logout"]');
    await logout.click();
    await expect(page).toHaveURL(/\/portal\/login/);

    await page.goBack();
    await expect(page).toHaveURL(/\/portal\/login/);
    await expect(page.locator('[data-testid="profile-form"]')).toHaveCount(0);
  });

  // KAIA-4011 — Finding B: the password rotation endpoint must
  // succeed in dev-mock so QA can verify the forced re-login
  // contract end-to-end. Initial credential for every fixture is the
  // deterministic `dev-old` string; the route persists the new value
  // in the in-memory store and returns reauth_required=true.
  test('rotates the password in dev-mock and forces a re-login', async ({ page, request }) => {
    await page.goto('/portal/perfil');

    // First rotation: dev-old → dev-new
    const firstRes = await request.post('/api/portal/me/password', {
      data: { currentPassword: 'dev-old', newPassword: 'dev-new-12345' },
    });
    expect(firstRes.ok()).toBeTruthy();
    const firstBody = (await firstRes.json()) as { ok: boolean; reauth_required: boolean };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.reauth_required).toBe(true);

    // Old credential must now be rejected.
    const staleRes = await request.post('/api/portal/me/password', {
      data: { currentPassword: 'dev-old', newPassword: 'another-1234567' },
    });
    expect(staleRes.status()).toBe(401);

    // New credential must be accepted.
    const okRes = await request.post('/api/portal/me/password', {
      data: { currentPassword: 'dev-new-12345', newPassword: 'dev-rotated-12345' },
    });
    expect(okRes.ok()).toBeTruthy();
  });
});

// KAIA-4011 — the contract for an unauthenticated request is a 307
// redirect to /portal/login. The dev-mock preview must honor that
// even though the Supabase env is configured; without the active
// flag, requirePortalSession() falls through to no_session.
test.describe('Unauthenticated contract (KAIA-4011)', () => {
  test('redirects /portal/perfil to /portal/login when no dev-mock cookies are set', async ({ request }) => {
    const res = await request.get('/portal/perfil', { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const location = res.headers()['location'] ?? '';
    expect(location).toMatch(/\/portal\/login/);
  });
});
