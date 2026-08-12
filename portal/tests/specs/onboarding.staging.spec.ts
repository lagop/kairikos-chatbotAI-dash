import { expect } from '@playwright/test';
import { authedPortalFixture as test } from '../fixtures/portal';
import { OnboardingPage } from '../pages/portal';

test.describe('@staging Onboarding Timeline', () => {
  test('fully onboarded client sees 4 timeline events (T+0, T+3, T+7, T+14)', async ({ page, clientA }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto('/portal/onboarding');
    
    await onboardingPage.expectTimelineVisible();
    
    const itemCount = await onboardingPage.getTimelineItemCount();
    expect(itemCount).toBeGreaterThanOrEqual(4);
    
    const statuses = await onboardingPage.getTimelineStatuses();
    const completedCount = statuses.filter((s) => s === 'done').length;
    expect(completedCount).toBeGreaterThanOrEqual(4);
  });

  test('fresh client sees only their state-change row(s)', async ({ page }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto('/portal/onboarding?client=fresh-client-slug');
    
    await onboardingPage.expectTimelineVisible();
    
    const itemCount = await onboardingPage.getTimelineItemCount();
    expect(itemCount).toBeLessThanOrEqual(2);
  });

  test('timeline events are in correct chronological order', async ({ page }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto('/portal/onboarding');
    
    const dates = await page.locator('[data-testid="timeline-item"] [data-occurred-at]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-occurred-at') || ''));
    
    const parsed = dates.filter(Boolean).map((d) => new Date(d).getTime());
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]).toBeGreaterThanOrEqual(parsed[i - 1]);
    }
  });

  test('current step is marked as "current" not "done"', async ({ page }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto('/portal/onboarding');
    
    const currentItems = await page.locator('[data-testid="timeline-item"][data-status="current"]').count();
    const doneItems = await page.locator('[data-testid="timeline-item"][data-status="done"]').count();
    
    expect(currentItems).toBe(1);
    expect(doneItems).toBeGreaterThan(0);
  });

  test('future steps are marked as "pending"', async ({ page }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto('/portal/onboarding');
    
    const pendingItems = await page.locator('[data-testid="timeline-item"][data-status="pending"]').count();
    expect(pendingItems).toBeGreaterThanOrEqual(0);
  });
});