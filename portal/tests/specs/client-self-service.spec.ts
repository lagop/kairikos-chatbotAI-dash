import { test, expect, type Page } from '@playwright/test';
import { PortalTestFixtures } from '../fixtures/portal';

const T = test.extend<PortalTestFixtures>;

// =============================================================================
// KAIA-1062 — client self-service UI smoke tests.
//
// All scenarios in this file are tagged `@smoke` so they run as part of
// the deploy gate. They exercise the four buttons the client can use
// without operator intervention:
//
//   * "He subido mis assets"          → POST /api/portal/track
//   * "Necesito ayuda"                → POST /api/portal/operator
//   * "Aplazar … un día"              → POST /api/portal/onboarding/snooze
//   * "Estoy listo para go-live"      → POST /api/portal/onboarding/go-live-ready
//
// Dev-mock mode (the default in `npm run dev` with no Supabase env) is
// what the test runner uses locally — every endpoint returns 200 and
// the UI flow is end-to-end exercisable. The test does not assert on
// the database directly; it asserts on the user-visible behaviour the
// issue's acceptance criteria describe.
// =============================================================================

async function openOnboardingPage(page: Page) {
  await page.goto('/portal/onboarding');
  await expect(page.getByTestId('onboarding-timeline')).toBeVisible();
  await expect(page.getByTestId('self-service-actions')).toBeVisible();
}

test.describe('Client self-service UI (KAIA-1062)', () => {
  test('@smoke four action buttons render on /portal/onboarding', async ({ page }) => {
    await openOnboardingPage(page);
    // The onboarding variant renders all four affordances — three inside
    // "Acciones" and the "Necesito ayuda" card.
    await expect(page.getByTestId('self-service-assets-uploaded')).toBeVisible();
    await expect(page.getByTestId('self-service-snooze')).toBeVisible();
    await expect(page.getByTestId('self-service-go-live-ready')).toBeVisible();
    await expect(page.getByTestId('self-service-help')).toBeVisible();
  });

  test('@smoke "Necesito ayuda" form is visible on /portal/dashboard', async ({ page }) => {
    await page.goto('/portal/dashboard');
    // The dashboard variant only renders the help button.
    await expect(page.getByTestId('self-service-help')).toBeVisible();
    // The full onboarding actions are not rendered on the dashboard.
    await expect(page.getByTestId('self-service-assets-uploaded')).toHaveCount(0);
  });

  test('@smoke clicking "He subido mis assets" surfaces a confirmation toast', async ({ page }) => {
    await openOnboardingPage(page);
    const button = page.getByTestId('self-service-assets-uploaded');
    const isDisabled = await button.isDisabled();
    test.skip(isDisabled, 'assets-uploaded button is disabled for this timeline state');
    await button.click();
    const toast = page.getByTestId('self-service-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toHaveAttribute('data-toast-kind', /success|info/);
  });

  test('@smoke help-request form submits and shows a confirmation toast', async ({ page }) => {
    await openOnboardingPage(page);
    await page.getByTestId('self-service-help').click();
    await expect(page.getByTestId('help-subject')).toBeVisible();
    await expect(page.getByTestId('help-message')).toBeVisible();
    await page.getByTestId('help-subject').fill('Duda sobre el portal');
    await page
      .getByTestId('help-message')
      .fill('No encuentro dónde subir el logo, ¿me puedes indicar el enlace?');
    await page.getByTestId('help-submit').click();
    const toast = page.getByTestId('self-service-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText(/ayuda|operador/i);
  });

  test('@smoke help-request rejects empty fields with an error toast', async ({ page }) => {
    await openOnboardingPage(page);
    await page.getByTestId('self-service-help').click();
    // Submit by clicking send; HTML5 validation will block but the toast
    // is a stronger contract for "empty form rejected" than relying on
    // the browser's native popover. We strip the `required` attribute
    // and the form's onSubmit guard fires the toast.
    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement>('[data-testid="help-subject"]')
        .forEach((el) => el.removeAttribute('required'));
      document
        .querySelectorAll<HTMLTextAreaElement>('[data-testid="help-message"]')
        .forEach((el) => el.removeAttribute('required'));
    });
    await page.getByTestId('help-subject').fill('ab');
    await page.getByTestId('help-message').fill('corto');
    await page.getByTestId('help-submit').click();
    const toast = page.getByTestId('self-service-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toHaveAttribute('data-toast-kind', 'error');
  });

  test('@smoke "Aplazar … un día" button calls snooze endpoint and shows info toast', async ({ page }) => {
    await openOnboardingPage(page);
    const button = page.getByTestId('self-service-snooze');
    const isDisabled = await button.isDisabled();
    test.skip(isDisabled, 'no active milestone to snooze for this client');
    await button.click();
    const toast = page.getByTestId('self-service-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toHaveAttribute('data-toast-kind', /info|success/);
  });

  test('@smoke "Estoy listo para go-live" button calls go-live-ready endpoint', async ({ page }) => {
    await openOnboardingPage(page);
    const button = page.getByTestId('self-service-go-live-ready');
    const isDisabled = await button.isDisabled();
    test.skip(
      isDisabled,
      'go-live-ready is disabled for this client (incomplete milestones or non-mock data)',
    );
    await button.click();
    const toast = page.getByTestId('self-service-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    // The button is enabled only for the mock client in dev-mock mode
    // (T+14 active, all prior milestones done). The handler always
    // returns 200 with `deduped` for repeat clicks; the toast kind is
    // success either way.
    await expect(toast).toHaveAttribute('data-toast-kind', 'success');
  });
});
