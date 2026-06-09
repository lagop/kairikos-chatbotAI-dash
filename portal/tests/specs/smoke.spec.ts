import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('@smoke portal loads without crash', async ({ page }) => {
    await page.goto('/portal');
    
    await expect(page).not.toHaveURL(/error|500|404/);
  });

  test('@smoke login page renders', async ({ page }) => {
    await page.goto('/portal/login');
    
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});