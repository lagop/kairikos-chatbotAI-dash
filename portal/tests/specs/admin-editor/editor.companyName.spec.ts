import { expect } from '@playwright/test';
import { portalFixture } from '../../fixtures/portal';

const test = portalFixture;

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const ACME_ID = '00000000-0000-0000-0000-000000000001';

async function loginAsOperator(page: import('@playwright/test').Page): Promise<void> {
  await page.context().clearCookies();
  const loginRes = await page.context().request.post(`${PORTAL_URL}/api/operator/login`, {
    data: {
      email: process.env.OPS_STAGING_OPERATOR_EMAIL ?? 'ops-staging@kairikos.com',
      password: process.env.OPS_STAGING_OPERATOR_PASSWORD ?? '',
    },
  });
  if (!loginRes.ok()) {
    throw new Error(`operator login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const setCookieHeader = loginRes.headers()['set-cookie'];
  if (setCookieHeader) {
    const match = setCookieHeader.match(/kairikos_operator_session=([^;]+)/);
    if (match) {
      await page.context().addCookies([{
        name: 'kairikos_operator_session',
        value: match[1],
        domain: new URL(PORTAL_URL).hostname,
        path: '/',
        sameSite: 'Lax',
        httpOnly: true,
        secure: true,
      }]);
    }
  }
  await page.goto(`${PORTAL_URL}/admin/portal/${ACME_ID}`);
  await page.waitForLoadState('networkidle');
}

test.describe('Admin Editor — companyName', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsOperator(page);
  });

  test('operator sees the editor section on the client detail page', async ({ page }) => {
    await expect(page.locator('[data-testid="operator-editor"]')).toBeVisible();
  });

  test('operator edits companyName, sees success toast, row updates', async ({ page }) => {
    const editor = page.locator('[data-testid="operator-editor"]');
    await expect(editor).toBeVisible();

    const input = page.locator('[data-testid="operator-edit-companyName"]');
    await expect(input).toBeVisible();

    const newValue = `Acme Corp — QA ${Date.now()}`;

    await input.fill(newValue);
    await page.locator('[data-testid="operator-edit-companyName-save"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/guardado/i);

    await expect(input).toHaveValue(newValue);
  });

  test('submitting the same companyName shows info toast, no change', async ({ page }) => {
    const input = page.locator('[data-testid="operator-edit-companyName"]');
    const originalValue = await input.inputValue();

    await input.fill(originalValue);
    await page.locator('[data-testid="operator-edit-companyName-save"]').click();

    const toast = page.locator('[data-testid="operator-editor-toast"]');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/ya está actualizado/i);
  });
});
