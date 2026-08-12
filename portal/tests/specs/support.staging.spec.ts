import { expect } from '@playwright/test';
import { authedPortalFixture as test } from '../fixtures/portal';
import { SupportPage } from '../pages/portal';

test.describe('@staging Support Page', () => {
  test('support page renders WhatsApp link', async ({ page }) => {
    const supportPage = new SupportPage(page);

    await page.goto('/portal/support');

    await supportPage.expectSupportLinksVisible();

    const whatsAppLink = page.locator('a[href*="wa.me"], a[href*="whatsapp"]');
    await expect(whatsAppLink).toBeVisible();
  });

  test('support page renders mailto link', async ({ page }) => {
    const supportPage = new SupportPage(page);

    await page.goto('/portal/support');

    await supportPage.expectSupportLinksVisible();

    const mailtoLink = page.locator('a[href^="mailto:"]');
    await expect(mailtoLink).toBeVisible();
    await expect(mailtoLink).toHaveAttribute('href', expect.stringContaining('@kairikos.com'));
  });

  test('support page is only accessible to authenticated clients', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/portal/support');

    await expect(page).toHaveURL(/\/portal\/login/);
  });

  test('support links are clickable and open correct channels', async ({ page }) => {
    const supportPage = new SupportPage(page);

    await page.goto('/portal/support');

    await supportPage.expectSupportLinksVisible();

    const whatsAppLink = page.locator('a[href*="wa.me"]').first();
    const mailtoLink = page.locator('a[href^="mailto:"]').first();

    await expect(whatsAppLink).toHaveAttribute('target', '_blank');
    await expect(mailtoLink).toHaveAttribute('href', expect.stringContaining('subject='));
  });
});