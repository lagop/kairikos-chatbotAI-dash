import { type BrowserContext, type Page } from '@playwright/test';
import { createStagingMagicLinkClient } from './staging-magic-link';

export interface AuthenticatedSession {
  email: string;
  context: BrowserContext;
  page: Page;
  url: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`staging-auth: required env var ${name} is not set`);
  return v;
}

// KAIA-1638 — loginAs / loginAndNavigate now drive the NextAuth.js v5
// magic-link flow (KAIA-753). The helper produces a
// /api/auth/callback/nodemailer URL that the real email would have
// contained; we visit it with Playwright instead of clicking through a
// real inbox. The NextAuth signIn callback (auth.ts) runs server-side
// and rejects unknown emails before a session is minted, so a typo in a
// test email is still caught the same way as in production.
export async function loginAs(
  page: Page,
  context: BrowserContext,
  email: string,
): Promise<void> {
  const client = createStagingMagicLinkClient(process.env as NodeJS.ProcessEnv);
  try {
    const link = await client.generateMagicLink(email, {
      redirectTo: `${requireEnv('PORTAL_URL')}/portal/wizard`,
    });
    await context.clearCookies();
    await page.goto(link, { waitUntil: 'networkidle' });
  } finally {
    await client.close();
  }
}

export async function loginAndNavigate(
  page: Page,
  context: BrowserContext,
  email: string,
  path: string,
): Promise<void> {
  const client = createStagingMagicLinkClient(process.env as NodeJS.ProcessEnv);
  try {
    const portalUrl = requireEnv('PORTAL_URL');
    const link = await client.generateMagicLink(email, {
      redirectTo: `${portalUrl}${path}`,
    });
    await context.clearCookies();
    await page.goto(link, { waitUntil: 'networkidle' });
  } finally {
    await client.close();
  }
}
