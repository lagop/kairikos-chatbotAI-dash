import { Page, Locator, expect } from '@playwright/test';
import type { TestClient } from '../fixtures/portal';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly noAccessMessage: Locator;
  readonly passwordInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.locator('input[type="email"], input[name="email"]');
    this.passwordInput = page.locator('[data-testid="password-input"]');
    this.submitButton = page.locator('button[type="submit"]');
    this.errorMessage = page.locator('[data-testid="signin-error"], .text-red-600');
    this.noAccessMessage = page.locator('text=no tienes acceso, text=no portal access', { exact: false });
  }

  async goto() {
    await this.page.goto('/portal/login');
  }

  async submitMagicLink(email: string) {
    await this.emailInput.fill(email);
    await this.submitButton.click();
  }

  async submitCredentials(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectNoAccessPage() {
    await expect(this.noAccessMessage).toBeVisible();
  }

  async expectError(message: string) {
    await expect(this.errorMessage).toContainText(message);
  }
}

export class OnboardingPage {
  readonly page: Page;
  readonly timeline: Locator;
  readonly timelineItems: Locator;

  constructor(page: Page) {
    this.page = page;
    this.timeline = page.locator('[data-testid="onboarding-timeline"], .timeline');
    this.timelineItems = page.locator('[data-testid="timeline-item"], .timeline-item');
  }

  async goto(clientSlug?: string) {
    const url = clientSlug ? `/portal/onboarding?client=${clientSlug}` : '/portal/onboarding';
    await this.page.goto(url);
  }

  async expectTimelineVisible() {
    await expect(this.timeline).toBeVisible();
  }

  async getTimelineItemCount(): Promise<number> {
    return this.timelineItems.count();
  }

  async getTimelineStatuses(): Promise<string[]> {
    return this.timelineItems.locator('[data-status]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-status') || '')
    );
  }
}

export class StatusPage {
  readonly page: Page;
  readonly statusBadge: Locator;
  readonly goLiveDate: Locator;
  readonly last7DaysStats: Locator;

  constructor(page: Page) {
    this.page = page;
    this.statusBadge = page.locator('[data-testid="status-badge"], .status-badge');
    this.goLiveDate = page.locator('[data-testid="go-live-date"], .go-live-date');
    this.last7DaysStats = page.locator('[data-testid="last-7-days"], .stats-7d');
  }

  async goto(clientSlug?: string) {
    const url = clientSlug ? `/portal/status?client=${clientSlug}` : '/portal/status';
    await this.page.goto(url);
  }

  async expectStatusVisible() {
    await expect(this.statusBadge).toBeVisible();
  }

  async getStatus(): Promise<string> {
    return this.statusBadge.textContent() || '';
  }
}

export class ConversationsPage {
  readonly page: Page;
  readonly conversationList: Locator;
  readonly conversationItems: Locator;
  readonly pagination: Locator;

  constructor(page: Page) {
    this.page = page;
    this.conversationList = page.locator('[data-testid="conversation-list"], .conversation-list');
    this.conversationItems = page.locator('[data-testid="conversation-item"], .conversation-item');
    this.pagination = page.locator('[data-testid="pagination"], .pagination');
  }

  async goto(clientSlug?: string) {
    const url = clientSlug ? `/portal/conversations?client=${clientSlug}` : '/portal/conversations';
    await this.page.goto(url);
  }

  async expectConversationsVisible() {
    await expect(this.conversationList).toBeVisible();
  }

  async getConversationCount(): Promise<number> {
    return this.conversationItems.count();
  }

  async expectPaginationVisible() {
    await expect(this.pagination).toBeVisible();
  }
}

export class BillingPage {
  readonly page: Page;
  readonly tierBadge: Locator;
  readonly stripePortalLink: Locator;
  readonly invoiceInfo: Locator;

  constructor(page: Page) {
    this.page = page;
    this.tierBadge = page.locator('[data-testid="tier-badge"], .tier-badge');
    this.stripePortalLink = page.locator('[data-testid="stripe-portal-link"], a[href*="stripe.com"]');
    this.invoiceInfo = page.locator('[data-testid="invoice-info"], .invoice-info');
  }

  async goto(clientSlug?: string) {
    const url = clientSlug ? `/portal/billing?client=${clientSlug}` : '/portal/billing';
    await this.page.goto(url);
  }

  async expectBillingVisible() {
    await expect(this.tierBadge).toBeVisible();
  }

  async clickStripePortalLink(): Promise<Page> {
    const [newPage] = await this.page.waitForEvent('popup');
    await this.stripePortalLink.click();
    return newPage;
  }

  async expectStripePortalOpensCorrectCustomer(expectedCustomerId: string) {
    const link = this.stripePortalLink;
    await expect(link).toHaveAttribute('href', expect.stringContaining(expectedCustomerId));
  }
}

export class SupportPage {
  readonly page: Page;
  readonly supportLinks: Locator;

  constructor(page: Page) {
    this.page = page;
    this.supportLinks = page.locator('[data-testid="support-links"], .support-links');
  }

  async goto(clientSlug?: string) {
    const url = clientSlug ? `/portal/support?client=${clientSlug}` : '/portal/support';
    await this.page.goto(url);
  }

  async expectSupportLinksVisible() {
    await expect(this.supportLinks).toBeVisible();
  }
}

export class AdminClientListPage {
  readonly page: Page;
  readonly clientRows: Locator;
  readonly searchInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.clientRows = page.locator('[data-testid="client-row"], .client-row');
    this.searchInput = page.locator('input[type="search"], input[name="search"]');
  }

  async goto() {
    await this.page.goto('/admin/portal/clients');
  }

  async expectClientListVisible() {
    await expect(this.clientRows.first()).toBeVisible();
  }

  async getClientCount(): Promise<number> {
    return this.clientRows.count();
  }

  async searchForClient(clientName: string) {
    await this.searchInput.fill(clientName);
    await this.page.waitForTimeout(500);
  }
}