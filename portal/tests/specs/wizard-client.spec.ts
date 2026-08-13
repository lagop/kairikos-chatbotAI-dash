import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// =============================================================================
// KAIA-1519 — client wizard tier-aware visibility (FE-1 deliverable #7).
//
// Happy path:
//   * Starter sees Steps 1, 2, 4, 5, 6, 8, 9, 10, 11
//     with Steps 3 and 7 rendered as "auto-configured" notices (no form).
//   * Pro sees all 11 steps with editable form controls.
//
// Tier switching in dev-mock mode:
//   The dev-mock session resolver (portal/src/lib/portal-session.ts:1) reads
//   the `kairikos-portal-dev-email` cookie and looks it up in
//   `DEV_MOCK_CLIENT_BY_EMAIL` (portal/src/lib/portal-data.ts). Setting the
//   cookie to one of the dev-mock fixture emails switches the resolved
//   client (and therefore the tier) without touching the database.
//
//   MOCK_CLIENT              (pro)     qa-test-client-a@kairikos.com
//   MOCK_SECONDARY_CLIENT    (premium) qa-test-client-b@kairikos.com
//   MOCK_STARTER_CLIENT      (starter) qa-test-client-starter@kairikos.com
//
// The dev server runs with no Supabase + no DATABASE_URL, so isDatabaseConfigured
// is false in `prisma` and the API returns 503. The wizard page falls back
// to the dev-mock branch which renders the tier-aware shell from the
// dev-mock client fixture.
// =============================================================================

const PRO_EMAIL = 'qa-test-client-a@kairikos.com';
const STARTER_EMAIL = 'qa-test-client-starter@kairikos.com';

async function setDevEmail(context: BrowserContext, email: string) {
  await context.clearCookies();
  await context.addCookies([
    {
      name: 'kairikos-portal-dev-email',
      value: email,
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
  ]);
}

async function openStep(page: Page, step: number | string) {
  await page.goto(`/portal/wizard/${step}`);
  await expect(page.getByRole('heading', { name: /^Paso \d+:/ })).toBeVisible({
    timeout: 10_000,
  });
}

// The wizard StepForm uses buttons (not a <form> element) to drive the
// PATCH /api/portal/wizard/[step] submission. For visible steps we expect
// the "Enviar para revisión" CTA, for hidden/auto-configured steps we
// expect the Spanish "configura automáticamente" notice and no submit
// button.
const SUBMIT_BUTTON_NAME = /Enviar para revisión|Guardar borrador/;
const AUTO_CONFIGURED_NOTICE = /se configura automáticamente para tu plan/i;

const STARTER_VISIBLE_STEPS = [1, 2, 4, 5, 6, 8, 9, 10, 11] as const;
const STARTER_HIDDEN_STEPS = [3, 7] as const;
const PRO_VISIBLE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

test.describe('Wizard client tier-aware visibility (KAIA-1519)', () => {
  test.describe('Starter tier', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test.beforeEach(async ({ context }) => {
      await setDevEmail(context, STARTER_EMAIL);
    });

    test('@smoke Starter session lands on Step 1 (first visible)', async ({ page }) => {
      await page.goto('/portal/wizard');
      await expect(page).toHaveURL(/\/portal\/wizard\/chatbot\/1$/);
    });

    for (const step of STARTER_VISIBLE_STEPS) {
      test(`@smoke Starter can see Step ${step} with a form`, async ({ page }) => {
        await openStep(page, step);
        // The StepForm renders submit buttons for visible steps.
        // Use `.first()` because the form has two buttons
        // ("Enviar para revisión" + "Guardar borrador") — we just need to
        // confirm at least one is present.
        await expect(
          page.getByRole('button', { name: SUBMIT_BUTTON_NAME }).first(),
        ).toBeVisible();
        // The auto-configured notice is NOT shown for visible steps.
        await expect(page.getByText(AUTO_CONFIGURED_NOTICE)).toHaveCount(0);
      });
    }

    for (const step of STARTER_HIDDEN_STEPS) {
      test(`@smoke Starter sees Step ${step} as auto-configured (no form)`, async ({ page }) => {
        await openStep(page, step);
        // No editable form for hidden steps: the "Enviar" / "Guardar borrador"
        // buttons are not rendered.
        await expect(
          page.getByRole('button', { name: SUBMIT_BUTTON_NAME }),
        ).toHaveCount(0);
        // The Spanish "auto-configured" notice is rendered instead.
        await expect(page.getByText(AUTO_CONFIGURED_NOTICE)).toBeVisible();
      });
    }

    test('@smoke Starter never sees Step 12 in the block progress', async ({ page }) => {
      await openStep(page, 1);
      // The three-block nav (Identidad / Comportamiento / Activación) does
      // not contain a "12" pill — Step 12 is `v11Deferred` and is
      // excluded from the block progress entirely. The pills are exposed
      // as `aria-label="Paso N: <title>"` spans, not as visible text, so
      // we query by aria-label.
      const progress = page.getByRole('navigation', { name: 'Progreso de configuración' });
      await expect(progress).toBeVisible();
      await expect(progress.getByLabel(/^Paso 12:/)).toHaveCount(0);
      // Steps 1-11 should still appear as informational pills, even when
      // hidden for the tier (Steps 3 and 7 are dimmed for Starter).
      await expect(progress.getByLabel(/^Paso 1:/)).toHaveCount(1);
      await expect(progress.getByLabel(/^Paso 11:/)).toHaveCount(1);
    });

    test('@smoke Starter next-link from Step 1 skips Step 3 and lands on Step 2', async ({ page }) => {
      await openStep(page, 1);
      // First "next" step in the Starter matrix is Step 2 (not Step 3).
      const nav = page.getByRole('navigation', { name: 'Navegación entre pasos' });
      const next = nav.getByRole('link').filter({ hasText: /→/ });
      await expect(next).toHaveAttribute('href', '/portal/wizard/chatbot/2');
    });
  });

  test.describe('Pro tier', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test.beforeEach(async ({ context }) => {
      await setDevEmail(context, PRO_EMAIL);
    });

    test('@smoke Pro session lands on Step 1', async ({ page }) => {
      await page.goto('/portal/wizard');
      await expect(page).toHaveURL(/\/portal\/wizard\/chatbot\/1$/);
    });

    for (const step of PRO_VISIBLE_STEPS) {
      test(`@smoke Pro can see Step ${step} with a form`, async ({ page }) => {
        await openStep(page, step);
        await expect(
          page.getByRole('button', { name: SUBMIT_BUTTON_NAME }).first(),
        ).toBeVisible();
        // The Starter-only auto-configured notice is never shown for Pro.
        await expect(page.getByText(AUTO_CONFIGURED_NOTICE)).toHaveCount(0);
      });
    }

    test('@smoke Pro next-link from Step 2 lands on Step 3 (not skipped)', async ({ page }) => {
      await openStep(page, 2);
      const nav = page.getByRole('navigation', { name: 'Navegación entre pasos' });
      const next = nav.getByRole('link').filter({ hasText: /→/ });
      await expect(next).toHaveAttribute('href', '/portal/wizard/chatbot/3');
    });
  });

  test.describe('Spanish strings (no English leakage)', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('@smoke wizard pages render in Spanish', async ({ page, context }) => {
      await setDevEmail(context, PRO_EMAIL);
      await openStep(page, 1);
      // The eyebrow + heading come from the portal chrome / messages bundle.
      await expect(page.getByText(/Configuración del chatbot/i)).toBeVisible();
      // English placeholders must not appear.
      await expect(page.getByText(/Submit for review/i)).toHaveCount(0);
      await expect(page.getByText(/Configure your chatbot/i)).toHaveCount(0);
    });
  });
});
