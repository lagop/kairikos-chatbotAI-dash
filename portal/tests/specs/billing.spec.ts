import { test, expect } from '@playwright/test';
import { PortalTestFixtures } from '../fixtures/portal';
import { BillingPage } from '../pages/portal';

const T = test.extend<PortalTestFixtures>;

test.describe('Billing', () => {
  test('Stripe Customer Portal link opens in new tab', async ({ page, clientA }) => {
    const billingPage = new BillingPage(page);
    
    await page.goto('/portal/billing');
    
    await billingPage.expectBillingVisible();
    
    const link = billingPage.stripePortalLink;
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('Stripe Portal link points to correct customer', async ({ page, clientA }) => {
    const billingPage = new BillingPage(page);
    
    await page.goto('/portal/billing');
    
    await billingPage.expectStripePortalOpensCorrectCustomer(clientA.stripeCustomerId || '');
  });

  test('tier badge shows correct tier', async ({ page, clientA }) => {
    const billingPage = new BillingPage(page);
    
    await page.goto('/portal/billing');
    
    await billingPage.expectBillingVisible();
    
    const tierText = await billingPage.tierBadge.textContent();
    expect(tierText?.toLowerCase()).toContain(clientA.tier);
  });

  test('billing page shows correct tier labels for all tiers', async ({ page }) => {
    const billingPage = new BillingPage(page);
    
    const tierLabels: Record<string, string> = {
      starter: 'Starter',
      pro: 'Pro',
      premium: 'Premium',
    };
    
    for (const [tier, expectedLabel] of Object.entries(tierLabels)) {
      await page.goto(`/portal/billing?tier=${tier}`);
      
      await billingPage.expectBillingVisible();
      const tierText = await billingPage.tierBadge.textContent();
      expect(tierText).toContain(expectedLabel);
    }
  });

  test('invoice info displays when available', async ({ page }) => {
    const billingPage = new BillingPage(page);
    
    await page.goto('/portal/billing');
    
    const invoiceInfo = billingPage.invoiceInfo;
    const isVisible = await invoiceInfo.isVisible().catch(() => false);
    
    if (isVisible) {
      await expect(invoiceInfo.locator('[data-testid="next-invoice-date"]')).toBeVisible();
    }
  });

  test('billing page is only accessible to authenticated clients', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/portal/billing');
    
    await expect(page).toHaveURL(/\/portal\/login/);
  });
});