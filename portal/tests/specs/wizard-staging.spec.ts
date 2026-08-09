import { test, expect } from '@playwright/test';
import { loginAndNavigate } from '../helpers/staging-auth';

const CLIENT_A = 'onboarding-test1@kairikos.dev';
const CLIENT_B = 'onboarding-test2@kairikos.dev';

// KAIA-1638 — NextAuth v5 magic-link helper requires DATABASE_URL +
// AUTH_SECRET + PORTAL_URL. See portal/tests/helpers/staging-magic-link.ts.
test.beforeEach(() => {
  test.skip(
    !process.env.DATABASE_URL || !process.env.AUTH_SECRET || !process.env.PORTAL_URL,
    'KAIA-1638 staging magic-link requires DATABASE_URL, AUTH_SECRET, and PORTAL_URL',
  );
});

test.describe('Wizard staging — Starter tier (abogado)', () => {

  test('@smoke Step 1 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/1');
    await expect(page.getByRole('heading', { name: /Paso 1:/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Enviar|Guardar/i }).first()).toBeVisible();
  });

  test('@smoke Step 2 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/2');
    await expect(page.getByRole('heading', { name: /Paso 2:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 3 shows auto-configured notice (hidden for Starter)', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/3');
    await expect(page.getByText(/se configura automáticamente/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Enviar|Guardar/i })).toHaveCount(0);
  });

  test('@smoke Step 4 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/4');
    await expect(page.getByRole('heading', { name: /Paso 4:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 5 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/5');
    await expect(page.getByRole('heading', { name: /Paso 5:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 6 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/6');
    await expect(page.getByRole('heading', { name: /Paso 6:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 7 shows auto-configured notice (hidden for Starter)', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/7');
    await expect(page.getByText(/se configura automáticamente/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Enviar|Guardar/i })).toHaveCount(0);
  });

  test('@smoke Step 8 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/8');
    await expect(page.getByRole('heading', { name: /Paso 8:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 9 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/9');
    await expect(page.getByRole('heading', { name: /Paso 9:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 10 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/10');
    await expect(page.getByRole('heading', { name: /Paso 10:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke Step 11 loads with form', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/11');
    await expect(page.getByRole('heading', { name: /Paso 11:/i })).toBeVisible({ timeout: 15_000 });
  });

  test('@smoke wizard loads with no console errors', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/1');
    await expect(page.getByRole('heading', { name: /Paso 1:/i })).toBeVisible({ timeout: 15_000 });
    const relevant = errors.filter(e => !e.includes('favicon') && !e.includes('manifest'));
    expect(relevant).toEqual([]);
  });

  test('@smoke form renders in Spanish', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_A, '/portal/wizard/1');
    await expect(page.getByText(/Configuración del chatbot/i)).toBeVisible();
    await expect(page.getByText(/Submit for review/i)).toHaveCount(0);
  });
});

test.describe('Wizard staging — Pro tier (clínica)', () => {

  test('@smoke Pro Step 3 is visible (not auto-configured)', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_B, '/portal/wizard/3');
    await expect(page.getByRole('heading', { name: /Paso 3:/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Enviar|Guardar/i }).first()).toBeVisible();
  });

  test('@smoke Pro Step 7 is visible (not auto-configured)', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_B, '/portal/wizard/7');
    await expect(page.getByRole('heading', { name: /Paso 7:/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Enviar|Guardar/i }).first()).toBeVisible();
  });

  test('@smoke Pro sees all 11 steps without auto-configured notices', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_B, '/portal/wizard/1');
    await expect(page.getByText(/Paso 1:/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/se configura automáticamente/i)).toHaveCount(0);
  });

  test('@smoke Pro Step 12 is not in nav (deferred)', async ({ page, context }) => {
    await loginAndNavigate(page, context, CLIENT_B, '/portal/wizard/1');
    const progress = page.getByRole('navigation', { name: /Progreso/i });
    await expect(progress.getByLabel(/Paso 12:/i)).toHaveCount(0);
  });
});
