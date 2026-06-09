import { test, expect } from '@playwright/test';
import { PortalTestFixtures, portalPages, adminPages } from '../fixtures/portal';
import { LoginPage, OnboardingPage, StatusPage, ConversationsPage, BillingPage, SupportPage, AdminClientListPage } from '../pages/portal';

const T = test.extend<PortalTestFixtures>;

test.describe('Cross-Tenant Isolation', () => {
  test('client-A cannot access client-B onboarding via direct URL', async ({ page, clientA, clientB }) => {
    const onboardingPage = new OnboardingPage(page);
    
    await page.goto(`/portal/onboarding?client=${clientB.slug}`);
    
    await expect(page).toHaveURL(/\/portal\/login|\/portal\/onboarding.*client=acme-corp/);
    const hasClientBData = await page.locator(`text=${clientB.companyName}`).isVisible().catch(() => false);
    expect(hasClientBData).toBe(false);
  });

  test('client-A cannot access client-B status via direct URL', async ({ page, clientA, clientB }) => {
    const statusPage = new StatusPage(page);
    
    await page.goto(`/portal/status?client=${clientB.slug}`);
    
    await expect(page).toHaveURL(/\/portal\/login|\/portal\/status.*client=acme-corp/);
    const hasClientBData = await page.locator(`text=${clientB.companyName}`).isVisible().catch(() => false);
    expect(hasClientBData).toBe(false);
  });

  test('client-A cannot access client-B conversations via direct URL', async ({ page, clientA, clientB }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto(`/portal/conversations?client=${clientB.slug}`);
    
    await expect(page).toHaveURL(/\/portal\/login|\/portal\/conversations.*client=acme-corp/);
  });

  test('client-A cannot access client-B billing via direct URL', async ({ page, clientA, clientB }) => {
    const billingPage = new BillingPage(page);
    
    await page.goto(`/portal/billing?client=${clientB.slug}`);
    
    await expect(page).toHaveURL(/\/portal\/login|\/portal\/billing.*client=acme-corp/);
  });

  test('client-A cannot access client-B support via direct URL', async ({ page, clientA, clientB }) => {
    const supportPage = new SupportPage(page);
    
    await page.goto(`/portal/support?client=${clientB.slug}`);
    
    await expect(page).toHaveURL(/\/portal\/login|\/portal\/support.*client=acme-corp/);
  });

  test('API: client-A fetching client-B conversations returns 403', async ({ page, clientA, clientB }) => {
    const response = await page.request.get(
      `/api/portal/conversations?client_id=${clientB.id}`,
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(403);
  });

  test('API: client-A fetching client-B activity returns 403', async ({ page, clientA, clientB }) => {
    const response = await page.request.get(
      `/api/portal/onboarding?client_id=${clientB.id}`,
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(403);
  });

  test('API: client-A fetching client-B billing returns 403', async ({ page, clientA, clientB }) => {
    const response = await page.request.get(
      `/api/portal/billing?client_id=${clientB.id}`,
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(403);
  });

  test('API: client-A fetching non-existent UUID returns empty (RLS enforced)', async ({ page, clientA }) => {
    const nonExistentClientId = '00000000-0000-0000-0000-999999999999';
    
    const response = await page.request.get(
      `/api/portal/conversations?client_id=${nonExistentClientId}`,
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('conversations');
    expect(data.conversations).toHaveLength(0);
  });

  test('admin endpoint: client JWT gets 403 on /admin/portal/clients', async ({ page, clientA }) => {
    const response = await page.request.get(
      '/api/admin/portal/clients',
      { headers: { Authorization: `Bearer ${clientA.id}` } }
    );
    
    expect(response.status()).toBe(403);
  });

  test('RLS negative test: removing RLS would expose cross-tenant data', async ({ page, clientA, clientB }) => {
    const conversationsPage = new ConversationsPage(page);
    
    await page.goto(`/portal/conversations`);
    const clientAConversations = await conversationsPage.getConversationCount();
    
    await page.goto(`/portal/conversations?client=${clientB.slug}`);
    const clientBConversations = await conversationsPage.getConversationCount();
    
    const hasOverlap = await page.evaluate(
      async (aId, bId) => {
        const resA = await fetch(`/api/portal/conversations?client_id=${aId}`);
        const resB = await fetch(`/api/portal/conversations?client_id=${bId}`);
        const dataA = await resA.json();
        const dataB = await resB.json();
        const idsA = new Set(dataA.conversations?.map((c: any) => c.id) || []);
        return dataB.conversations?.some((c: any) => idsA.has(c.id)) || false;
      },
      clientA.id,
      clientB.id
    );
    
    expect(hasOverlap).toBe(false);
  });
});

test.describe('Magic Link Authentication', () => {
  test('non-client email gets friendly no-access page', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    
    await loginPage.submitMagicLink('random-person@example.com');
    
    await loginPage.expectNoAccessPage();
  });

  test('unregistered email format gets validation error', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    
    await loginPage.submitMagicLink('not-an-email');
    
    await loginPage.expectError('formato');
  });

  test('client email gets magic link (mocked in test env)', async ({ page, clientA }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    
    await loginPage.submitMagicLink(clientA.primaryContactEmail);
    
    await expect(page.locator('text=revisa tu correo, check your email', { exact: false })).toBeVisible();
  });

  test('magic link token expires after use', async ({ page, clientA }) => {
    await page.goto(`/portal/login?token=mock-expired-token`);
    
    await expect(page).toHaveURL(/\/portal\/login/);
    await expect(page.locator('text=enlace expirado, link expired', { exact: false })).toBeVisible();
  });
});