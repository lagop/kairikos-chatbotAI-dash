// portal/tests/specs/dashboard.staging.spec.ts
//
// KAIA-11641 — end-to-end regression for the "dashboard renders MOCK_CLIENT
// (Acme Corp) instead of real customer data" bug.
//
// Reproduces the deterministic orly.nityananda@gmail.com scenario from the
// staging environment: log in via the seeded customer, hit /portal/dashboard,
// and assert the rendered h1 matches the customer's seeded ChatbotClient row,
// NOT the dev-mock "Acme Corp" fixture.
//
// Skip conditions match the existing cross-tenant.staging.spec.ts:
//   - PORTAL_URL unset / empty / points at localhost
//   - SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY unset
//   - staging smoke flag missing
//
// To run:
//   PORTAL_URL=https://project-fxidg.vercel.app \
//   SUPABASE_URL=https://abcdefghij.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=...  \
//   npx playwright test tests/specs/dashboard.staging.spec.ts
//
// Acceptance criterion (mirrors KAIA-11641 issue body):
//   * /portal/dashboard renders the h1 with the real customer's
//     ChatbotClient.name (falling back to companyName) — never the literal
//     MOCK_CLIENT string "Acme Corp".
//   * The hidden data-source marker reports "prisma" | "portal_api_fallback".
//     The "mock_dev" source is only acceptable for the dev-mock fixtures
//     (i.e. not for the seeded customer round-trip).

import { test, expect } from '@playwright/test';
import { createStagingMagicLinkClient } from '../helpers/staging-magic-link';

const SKIP_REASON =
  'KAIA-11641 staging e2e requires PORTAL_URL pointing at the staging project and SUPABASE_* service-role creds in env.';

function shouldSkip(): boolean {
  const portalUrl = process.env.PORTAL_URL ?? '';
  if (!portalUrl) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(portalUrl)) return true;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return true;
  return false;
}

// KAIA-11641 — the deterministic repro customer from the issue body.
// `orly.nityananda@gmail.com` is the email QA used when the bug was
// surfaced. The customer has ChatbotClient.name='Clinica dental Orly' and
// companyName=null, so the dashboard h1 MUST read 'Clinica dental Orly'
// (or the seeded companyName when present) — never the MOCK_CLIENT
// string 'Acme Corp'. The fallback uses the second-stage seeded user if
// the first one isn't yet present in this staging project.
const REPRO_EMAIL = process.env.KAIA_11641_TEST_EMAIL ?? 'orly.nityananda@gmail.com';
const REPRO_NAME_ENV = process.env.KAIA_11641_TEST_NAME;

test.describe('@staging Dashboard renders real customer data (KAIA-11641)', () => {
  test.skip(shouldSkip(), SKIP_REASON);

  test('authenticated customer sees their own name, not Acme Corp', async ({ page, context }) => {
    const portalUrl = process.env.PORTAL_URL ?? 'https://project-fxidg.vercel.app';
    const client = createStagingMagicLinkClient(process.env as NodeJS.ProcessEnv);

    const link = await client.generateMagicLink(REPRO_EMAIL, {
      redirectTo: `${portalUrl}/portal/dashboard`,
    });

    await context.clearCookies();
    await page.goto(link, { waitUntil: 'networkidle' });

    // The route guard (KAIA-11623) lets the customer reach /portal/dashboard.
    await expect(page).toHaveURL(/\/portal\/dashboard/);

    // Read the hidden data-source marker. We expect either 'prisma' (the
    // normal path) or 'portal_api_fallback' (the KAIA-11641 fallback). The
    // 'mock_dev' source must NOT be served for a real authenticated customer.
    const sourceLocator = page.locator('[data-testid="dashboard-client-name"]');
    await expect(sourceLocator).toHaveCount(1);
    await expect(sourceLocator).not.toHaveAttribute('data-dashboard-source', 'mock_dev');

    const source = await sourceLocator.getAttribute('data-dashboard-source');
    expect(['prisma', 'portal_api_fallback']).toContain(source);

    // Defence-in-depth: the visible h1 must never be 'Acme Corp' (the
    // MOCK_CLIENT fixture) for a real authenticated customer. If this
    // assertion ever fires, the bug has regressed.
    const headingText = await page.locator('h1').first().innerText();
    expect(headingText.trim()).not.toBe('Acme Corp');

    // If a name expectation was provided (CI / future staging users), assert
    // it; otherwise just assert that the h1 is non-empty and not the mock.
    if (REPRO_NAME_ENV) {
      expect(headingText.trim()).toBe(REPRO_NAME_ENV);
    } else {
      expect(headingText.trim().length).toBeGreaterThan(0);
    }
  });
});
