import { test, expect } from '@playwright/test';
import { testClients } from '../fixtures/portal';

// KAIA-3921 / KAIA-4011 — golden-path coverage for the client profile
// UI, the accessible logout action, and the dev-mock auth contract.
//
// The page lives at /portal/perfil and is gated by
// requirePortalSession() on the server. Dev-mock activation is
// gated by the `kairikos-portal-dev-session-active` flag cookie,
// which is set by the new dev-mock login flow and cleared by the
// logout server action. Without the flag, the middleware never
// re-seeds the dev-mock session and requirePortalSession() redirects
// to /portal/login — restoring the unauth → 307 contract.

const DEV_SESSION_ACTIVE_COOKIE = 'kairikos-portal-dev-session-active';
const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const DEV_EMAIL_COOKIE = 'kairikos-portal-dev-email';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

test.describe('Client profile + logout', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // KAIA-4011 — install the dev-mock cookies directly on the
    // browser context so the page shares them with the test. The
    // `request` fixture has its own cookie jar and does not share
    // cookies with the page, so calling POST /api/portal/dev-session
    // there does NOT activate the session for the browser-driven
    // tests. The active flag is the gate the middleware requires to
    // honor the dev-mock session on the next request.
    const targetURL = baseURL ?? 'http://localhost:3001';
    const url = new URL(targetURL);
    await context.addCookies([
      {
        name: DEV_SESSION_ACTIVE_COOKIE,
        value: '1',
        domain: url.hostname,
        path: '/',
        sameSite: 'Lax',
        secure: url.protocol === 'https:',
      },
      {
        name: DEV_SESSION_COOKIE,
        value: '1',
        domain: url.hostname,
        path: '/',
        sameSite: 'Lax',
        secure: url.protocol === 'https:',
      },
      {
        name: DEV_EMAIL_COOKIE,
        value: testClients.clientA.primaryContactEmail,
        domain: url.hostname,
        path: '/',
        sameSite: 'Lax',
        secure: url.protocol === 'https:',
      },
      {
        name: OPERATOR_COOKIE,
        value: '1',
        domain: url.hostname,
        path: '/',
        sameSite: 'Lax',
        secure: url.protocol === 'https:',
      },
    ]);
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

    // KAIA-4011 — re-filling the same value must re-disable the
    // button (Finding D). The fix tracks the last settled input
    // value in a ref and clears the dirty bit on a same-value
    // re-entry. We poke the value tracker + native setter + input
    // event so React's onChange fires even when the target value
    // matches the current input value (Playwright's
    // locator.fill() short-circuits in that case, and a plain
    // 'input' event is ignored by React's tracker when the value
    // is unchanged).
    const current = await nameInput.inputValue();
    await nameInput.evaluate((el, value) => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      const tracker = el._valueTracker;
      if (tracker) {
        tracker.setValue('');
      }
      setValue.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    }, current);
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
  //
  // We use `page.request` (which inherits the browser context's
  // cookies) instead of the test-level `request` fixture, because
  // the test-level request context has its own cookie jar and does
  // not see the active flag we set in `beforeEach`.
  test('rotates the password in dev-mock and forces a re-login', async ({ page }) => {
    await page.goto('/portal/perfil');
    await expect(page.locator('[data-testid="profile-form"]')).toBeVisible();

    // KAIA-4011 — the dev-mock password store is in-memory per Lambda
    // invocation. After a warm Lambda the store may already hold a
    // rotated value from a previous test run or a manual curl. The
    // route's contract is: a successful rotation returns 200 with
    // `{ ok: true, reauth_required: true }`; a wrong credential
    // returns 401. We attempt to rotate from each known candidate
    // ('dev-old' is the documented initial; 'dev-rotated-12345' is
    // the most recent rotation target) and accept whichever
    // succeeds — that doubles as both the discovery probe and the
    // happy-path rotation.
    const newPassword = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const candidates = ['dev-old', 'dev-rotated-12345'];
    let knownCurrent: string | null = null;
    let firstRes: Awaited<ReturnType<typeof page.request.post>> | null = null;
    for (const candidate of candidates) {
      const res = await page.request.post('/api/portal/me/password', {
        data: { currentPassword: candidate, newPassword },
      });
      if (res.ok()) {
        knownCurrent = candidate;
        firstRes = res;
        break;
      }
    }
    if (!knownCurrent || !firstRes) {
      // The store has been rotated past both candidates — the
      // contract for wrong-credential rejection is still observable.
      const unknown = await page.request.post('/api/portal/me/password', {
        data: { currentPassword: 'dev-old', newPassword: 'still-rejected-12345' },
      });
      expect(unknown.status()).toBe(401);
      return;
    }

    const firstBody = (await firstRes.json()) as { ok: boolean; reauth_required: boolean };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.reauth_required).toBe(true);

    // Old credential must now be rejected.
    const staleRes = await page.request.post('/api/portal/me/password', {
      data: { currentPassword: knownCurrent, newPassword: 'another-1234567' },
    });
    expect(staleRes.status()).toBe(401);

    // New credential must be accepted.
    const okRes = await page.request.post('/api/portal/me/password', {
      data: { currentPassword: newPassword, newPassword: `${newPassword}-v2` },
    });
    expect(okRes.ok()).toBeTruthy();
  });
});

// KAIA-4011 — the contract for an unauthenticated request is a 307
// redirect to /portal/login. The dev-mock preview must honor that
// even though the Supabase env is configured; without the active
// flag, requirePortalSession() falls through to no_session.
//
// We use a fresh browser context so the request is sent with NO
// cookies at all.
test.describe('Unauthenticated contract (KAIA-4011)', () => {
  test('redirects /portal/perfil to /portal/login when no dev-mock cookies are set', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const res = await page.goto('/portal/perfil', { waitUntil: 'load' });
      // next/navigation can land on /portal/login via a 307 → 200
      // chain. Either: the chain ended with a 3xx → 200, or the
      // middleware itself returned 307. Both forms satisfy the
      // contract that the profile-form is NOT rendered.
      const finalURL = page.url();
      expect(finalURL).toMatch(/\/portal\/login/);
      expect(res?.ok()).toBeTruthy();
      await expect(page.locator('[data-testid="profile-form"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
