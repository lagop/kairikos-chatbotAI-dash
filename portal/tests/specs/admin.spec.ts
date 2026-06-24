import { expect } from '@playwright/test';
import { portalFixture as test } from '../fixtures/portal';
import { AdminClientListPage } from '../pages/portal';

test.describe('Admin Support View', () => {
  test('operator account at /admin/portal/clients sees all clients', async ({ page }) => {
    const adminPage = new AdminClientListPage(page);
    
    await page.goto('/admin/portal/clients');
    
    await adminPage.expectClientListVisible();
    
    const count = await adminPage.getClientCount();
    expect(count).toBeGreaterThan(1);
  });

  test('client JWT gets 403 on admin client list page', async ({ page, clientA }) => {
    const response = await page.request.get(
      '/admin/portal/clients',
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(403);
  });

  test('unauthenticated request to admin gets redirect to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/admin/portal/clients');

    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('admin page shows client onboarding status', async ({ page }) => {
    const adminPage = new AdminClientListPage(page);
    
    await page.goto('/admin/portal/clients');
    
    const firstRow = adminPage.clientRows.first();
    await expect(firstRow.locator('[data-testid="client-status"]')).toBeVisible();
  });

  test('admin can search for specific client', async ({ page }) => {
    const adminPage = new AdminClientListPage(page);
    
    await page.goto('/admin/portal/clients');
    
    await adminPage.searchForClient('Acme');
    
    const rows = await adminPage.getClientCount();
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  test('admin page displays client contact email', async ({ page }) => {
    const adminPage = new AdminClientListPage(page);
    
    await page.goto('/admin/portal/clients');
    
    const firstRow = adminPage.clientRows.first();
    await expect(firstRow.locator('[data-testid="client-email"]')).toBeVisible();
  });
});