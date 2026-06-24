import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('@smoke portal loads without crash', async ({ page }) => {
    await page.goto('/portal');
    
    await expect(page).not.toHaveURL(/error|500|404/);
  });

  test('@smoke login page renders', async ({ page }) => {
    await page.goto('/portal/login');

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('[data-testid="password-input"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('@smoke admin login page renders', async ({ page }) => {
    await page.goto('/admin/login');

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('[data-testid="password-input"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});