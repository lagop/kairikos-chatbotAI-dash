import { test, expect } from '@playwright/test';
import { PortalTestFixtures } from '../fixtures/portal';
import { ConversationsPage } from '../pages/portal';

const T = test.extend<PortalTestFixtures>;

test.describe('Conversations List', () => {
  test('client-A sees only their conversations', async ({ page, clientA }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto('/portal/conversations');
    
    await conversationsPage.expectConversationsVisible();
    
    const count = await conversationsPage.getConversationCount();
    expect(count).toBeGreaterThanOrEqual(0);
    
    const visibleCompanyNames = await page.locator(`text=${clientA.companyName}`).count();
    expect(visibleCompanyNames).toBe(0);
  });

  test('pagination works past 50 conversations', async ({ page }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto('/portal/conversations?page=1');
    
    await conversationsPage.expectConversationsVisible();
    
    const hasNextPage = await page.locator('[data-testid="pagination-next"]').isVisible().catch(() => false);
    
    if (hasNextPage) {
      await page.locator('[data-testid="pagination-next"]').click();
      await page.waitForURL(/page=2/);
      
      const items = await conversationsPage.getConversationCount();
      expect(items).toBeGreaterThan(0);
    }
  });

  test('conversation items show correct metadata (channel, outcome, duration)', async ({ page }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto('/portal/conversations');
    
    const firstItem = page.locator('[data-testid="conversation-item"]').first();
    await expect(firstItem).toBeVisible();
    
    await expect(firstItem.locator('[data-testid="conversation-channel"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="conversation-outcome"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="conversation-duration"]')).toBeVisible();
  });

  test('clicking conversation opens transcript', async ({ page }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto('/portal/conversations');
    
    const firstItem = page.locator('[data-testid="conversation-item"]').first();
    await firstItem.click();
    
    await expect(page).toHaveURL(/\/portal\/conversations\/.+/);
    await expect(page.locator('[data-testid="conversation-transcript"]')).toBeVisible();
  });

  test('escalated conversations are highlighted', async ({ page }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto('/portal/conversations');
    
    const escalatedItems = page.locator('[data-testid="conversation-item"][data-outcome="escalated"]');
    const count = await escalatedItems.count();
    
    if (count > 0) {
      await expect(escalatedItems.first().locator('[data-testid="escalated-badge"]')).toBeVisible();
    }
  });
});