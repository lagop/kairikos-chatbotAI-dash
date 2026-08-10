import { expect } from '@playwright/test';
import { portalFixture } from '../../fixtures/portal';

const test = portalFixture;

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const ACME_ID = '00000000-0000-0000-0000-000000000001';

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
  if (!href) {
    throw new Error('no client rows in /admin/portal/clients table');
  }
  const clientId = href.replace('/admin/portal/', '').split('?')[0];
  await page.goto(`${PORTAL_URL}/admin/portal/${clientId}`);
  await page.waitForLoadState('networkidle');
  return clientId;
}

test.describe('Admin Editor — email', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFirstClient(page);
  });

  test('editing email shows confirmation modal before submit', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-email"]');
    await expect(input).toBeVisible();

    const newEmail = `qa-new-contact-${Date.now()}@kairikos-evidence.com`;

    await input.fill(newEmail);
    await page.locator('[data-testid="operator-edit-email-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-email"]');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await expect(modal.locator('#operator-confirm-title')).toContainText(/email/i);
  });

  test('confirmation modal cancel returns to edit without submitting', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-email"]');
    const originalEmail = await input.inputValue();

    await input.fill(`cancel-test-${Date.now()}@kairikos-evidence.com`);
    await page.locator('[data-testid="operator-edit-email-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-email"]');
    await expect(modal).toBeVisible({ timeout: 3000 });

    await page.locator('[data-testid="operator-confirm-email-cancel"]').click();
    await expect(modal).not.toBeVisible();

    await expect(input).not.toHaveValue(`cancel-test-${Date.now()}@kairikos-evidence.com`);
    await expect(input).toHaveValue(originalEmail);
  });

  test('confirming email change shows success toast', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-email"]');
    await expect(input).toBeVisible();

    const newEmail = `qa-confirm-${Date.now()}@kairikos-evidence.com`;

    await input.fill(newEmail);
    await page.locator('[data-testid="operator-edit-email-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-email"]');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await page.locator('[data-testid="operator-confirm-email-confirm"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/email/i);
  });
});
