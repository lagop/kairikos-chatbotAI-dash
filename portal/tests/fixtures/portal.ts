import { test as base } from '@playwright/test';
import type { ChatbotClient, ChatbotClientUser } from '../src/types/portal';
import { createStagingMagicLinkClient } from '../helpers/staging-magic-link';

export type TestClient = {
  id: string;
  slug: string;
  companyName: string;
  primaryContactEmail: string;
  stripeCustomerId: string | null;
  tier: 'starter' | 'pro' | 'premium';
  onboardingStatus: 'pending' | 'in_progress' | 'live' | 'paused' | 'cancelled';
  users: TestUser[];
};

export type TestUser = {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'viewer';
  clientId: string;
};

export interface PortalPage {
  url: string;
  expectedTitle: string;
}

declare global {
  interface Window {
    __TEST_CLIENT_A?: TestClient;
    __TEST_CLIENT_B?: TestClient;
  }
}

export const testClients: Record<string, TestClient> = {
  clientA: {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'acme-corp',
    companyName: 'Acme Corp',
    primaryContactEmail: 'qa-test-client-a@kairikos.com',
    stripeCustomerId: 'cus_test_client_a',
    tier: 'pro',
    onboardingStatus: 'live',
    users: [
      {
        id: '00000000-0000-0000-0000-000000000011',
        email: 'qa-test-client-a@kairikos.com',
        role: 'owner',
        clientId: '00000000-0000-0000-0000-000000000001',
      },
    ],
  },
  clientB: {
    id: '00000000-0000-0000-0000-000000000002',
    slug: 'globex-inc',
    companyName: 'Globex Inc',
    primaryContactEmail: 'qa-test-client-b@kairikos.com',
    stripeCustomerId: 'cus_test_client_b',
    tier: 'premium',
    onboardingStatus: 'in_progress',
    users: [
      {
        id: '00000000-0000-0000-0000-000000000021',
        email: 'qa-test-client-b@kairikos.com',
        role: 'owner',
        clientId: '00000000-0000-0000-0000-000000000002',
      },
    ],
  },
};

export const testUsers = {
  clientA: testClients.clientA.users[0],
  clientB: testClients.clientB.users[0],
  nonPortalEmail: {
    id: '00000000-0000-0000-0000-000000000099',
    email: 'random-user@example.com',
    role: 'viewer' as const,
    clientId: '',
  },
};

export const portalPages: Record<string, PortalPage> = {
  login: { url: '/portal/login', expectedTitle: 'Iniciar sesión' },
  onboarding: { url: '/portal/onboarding', expectedTitle: 'Onboarding' },
  status: { url: '/portal/status', expectedTitle: 'Estado del chatbot' },
  conversations: { url: '/portal/conversations', expectedTitle: 'Conversaciones' },
  billing: { url: '/portal/billing', expectedTitle: 'Facturación' },
  support: { url: '/portal/support', expectedTitle: 'Soporte' },
};

export const adminPages = {
  clientList: { url: '/admin/portal/clients', expectedTitle: 'Clientes' },
};

export class PortalTestFixtures {
  clientA = testClients.clientA;
  clientB = testClients.clientB;
  userA = testUsers.clientA;
  userB = testUsers.clientB;
  nonPortalUser = testUsers.nonPortalEmail;
}

export const portalFixture = base.extend<PortalTestFixtures>({
  clientA: testClients.clientA,
  clientB: testClients.clientB,
  userA: testUsers.clientA,
  userB: testUsers.clientB,
  nonPortalUser: testUsers.nonPortalEmail,
});

export const authedPortalFixture = portalFixture.extend({
  clientA: async ({ clientA, page, context }, use) => {
    const portalUrl = process.env.PORTAL_URL ?? 'https://project-fxidg.vercel.app';
    const client = createStagingMagicLinkClient(process.env as NodeJS.ProcessEnv);
    const link = await client.generateMagicLink(clientA.users[0].email, {
      redirectTo: `${portalUrl}/portal/dashboard`,
    });
    await context.clearCookies();
    await page.goto(link, { waitUntil: 'networkidle' });
    await use(clientA);
  },
});