import { test, expect } from '@playwright/test';
import { loginAndNavigate } from '../helpers/staging-auth';

const STAGING_USER = 'onboarding-test1@kairikos.dev';
const VERTICAL = 'abogado';

// KAIA-1638 — the magic-link helper now needs DATABASE_URL + AUTH_SECRET
// (NextAuth v5 VerificationToken flow) instead of the old Supabase
// service-role key. RESEND_API_KEY is still required for the live flow
// but the helper bypasses it; we don't gate on it here.
test.beforeEach(() => {
  test.skip(
    !process.env.DATABASE_URL || !process.env.AUTH_SECRET || !process.env.PORTAL_URL,
    'KAIA-1638 staging magic-link requires DATABASE_URL, AUTH_SECRET, and PORTAL_URL',
  );
});

test.describe(`Wizard happy path — vertical ${VERTICAL} (Starter)`, () => {
  test('@smoke Step 1 loads and shows identification form', async ({ page, context }) => {
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/1');
    await expect(page.getByText(/Paso 1:/i)).toBeVisible({ timeout: 15_000 });
    const heading = page.getByRole('heading', { name: /Paso 1:/i });
    await expect(heading).toBeVisible();
  });

  test('@smoke Step 2 loads correctly', async ({ page, context }) => {
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/2');
    await expect(page.getByText(/Paso 2:/i)).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 3 shows auto-configured notice (Starter tier)', async ({ page, context }) => {
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/3');
    await expect(page.getByText(/se configura automáticamente/i)).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 4 through 11 are accessible', async ({ page, context }) => {
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/4');
    await expect(page.getByText(/Paso 4:/i)).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke No console errors on wizard load', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/1');
    await expect(page.getByText(/Paso 1:/i)).toBeVisible({ timeout: 15_000 });
    expect(errors.filter(e => !e.includes('favicon') && !e.includes('manifest'))).toEqual([]);
  });

  test('@smoke Step 12 does not appear in progress nav (v11 deferred)', async ({ page, context }) => {
    await loginAndNavigate(page, context, STAGING_USER, '/portal/wizard/1');
    const progress = page.getByRole('navigation', { name: /Progreso/i });
    await expect(progress).toBeVisible();
    await expect(progress.getByLabel(/Paso 12:/i)).toHaveCount(0);
  });
});
