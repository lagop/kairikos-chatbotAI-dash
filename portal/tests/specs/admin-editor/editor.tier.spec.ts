import { expect } from '@playwright/test';
import { portalFixture } from '../../fixtures/portal';

const test = portalFixture;

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const ACME_ID = '00000000-0000-0000-0000-000000000001';

async function loginAsOperator(page: import('@playwright/test').Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`${PORTAL_URL}/admin/login`);
  await page.waitForLoadState('networkidle');
  const emailInput = page.locator('input[name="email"], input[type="email"]');
  const passwordInput = page.locator('input[name="password"]');
  await emailInput.fill(process.env.OPS_STAGING_OPERATOR_EMAIL ?? 'ops-staging@kairikos.com');
  await passwordInput.fill(process.env.OPS_STAGING_OPERATOR_PASSWORD ?? '');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/portal/, { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}

test.describe('Admin Editor — tier', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsOperator(page);
  });

  test('changing tier shows confirmation modal before submit', async ({ page }) => {
    const select = page.locator('[data-testid="operator-edit-tier"]');
    await expect(select).toBeVisible();

    const currentTier = await select.inputValue();
    const nextTier = currentTier === 'starter' ? 'pro' : 'starter';

    await select.selectOption(nextTier);
    await page.locator('[data-testid="operator-edit-tier-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-tier"]');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await expect(modal.locator('#operator-confirm-title')).toContainText(/plan/i);
  });

  test('confirmation modal cancel returns to previous tier', async ({ page }) => {
    const select = page.locator('[data-testid="operator-edit-tier"]');
    const originalTier = await select.inputValue();

    const otherTier = originalTier === 'starter' ? 'premium' : 'starter';
    await select.selectOption(otherTier);
    await page.locator('[data-testid="operator-edit-tier-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-tier"]');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await page.locator('[data-testid="operator-confirm-tier-cancel"]').click();
    await expect(modal).not.toBeVisible();
    await expect(select).toHaveValue(originalTier);
  });

  test('confirming tier change shows success toast with tier label', async ({ page }) => {
    const select = page.locator('[data-testid="operator-edit-tier"]');
    const currentTier = await select.inputValue();
    const nextTier = currentTier === 'starter' ? 'pro' : 'starter';

    await select.selectOption(nextTier);
    await page.locator('[data-testid="operator-edit-tier-save"]').click();

    const modal = page.locator('[data-testid="operator-confirm-modal-tier"]');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await page.locator('[data-testid="operator-confirm-tier-confirm"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/actualizado|plan/i);
  });
});
