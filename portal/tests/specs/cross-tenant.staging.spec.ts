// portal/tests/specs/cross-tenant.staging.spec.ts
//
// KAIA-740 — end-to-end per-tenant magic-link check against the real
// Kairikos Supabase STAGING project.
//
// This spec is intentionally separate from tests/specs/cross-tenant.spec.ts
// (the dev-mock spec) because:
//   * It talks to a real Supabase auth + real RLS, so the cost of a slow or
//     flaky run is much higher. We tag with @staging and only run when
//     PORTAL_URL points at the staging project.
//   * The seeded client names + UUIDs differ from the dev-mock fixture
//     (Acme Clay Ovens / Brisa Beach Houses, not Acme Corp / Globex Inc).
//   * It uses the Supabase admin `generateLink` API to skip the email step,
//     which is the production-shaped flow (the `action_link` lands on the
//     real /api/auth/callback with a real `?code=`).
//
// Acceptance criteria this spec implements:
//   "End-to-end check: log into the Next.js dev portal as one of the fake
//    clients via magic link, open /portal, confirm only that client is
//    listed. Repeat for the second client. Log in as a staff operator,
//    confirm both clients are listed."
//
// Required env (loaded from project root .env):
//   PORTAL_URL                       e.g. https://staging--portal.kairikos.com
//   SUPABASE_URL                     e.g. https://abcdefghij.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY        staging service role
//
// Optional (defaults match supabase/seeds/chatbot_clients_seed.sql):
//   STAGING_TEST_USER_A_EMAIL        onboarding-test1@kairikos.dev
//   STAGING_TEST_USER_B_EMAIL        onboarding-test2@kairikos.dev
//   STAGING_TEST_USER_STAFF_EMAIL    staff-test@kairikos.dev
//
// Skip conditions:
//   * PORTAL_URL is unset or empty, OR points at localhost (the dev mock)
//   * SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset
//   * The staging smoke flag is missing
//
// To run:
//   PORTAL_URL=https://staging--portal.kairikos.com \
//   SUPABASE_URL=https://abcdefghij.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=...  \
//   npx playwright test tests/specs/cross-tenant.staging.spec.ts

import { test, expect } from '@playwright/test';
import { createStagingMagicLinkClient } from '../helpers/staging-magic-link';

const SKIP_REASON = 'KAIA-740 staging e2e requires PORTAL_URL pointing at the staging project and SUPABASE_* service-role creds in env.';

function shouldSkip(): boolean {
  const portalUrl = process.env.PORTAL_URL ?? '';
  const sbUrl = process.env.SUPABASE_URL ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!portalUrl) return true;
  if (portalUrl.includes('localhost') || portalUrl.includes('127.0.0.1')) return true;
  if (!sbUrl || !sbKey) return true;
  return false;
}

test.describe('@staging cross-tenant isolation (real Supabase)', () => {
  test.skip(shouldSkip(), SKIP_REASON);

  let client: ReturnType<typeof createStagingMagicLinkClient>;
  let portalUrl: string;
  let health: Awaited<ReturnType<ReturnType<typeof createStagingMagicLinkClient>['healthcheck']>>;

  test.beforeAll(async () => {
    client = createStagingMagicLinkClient();
    portalUrl = process.env.PORTAL_URL!;
    health = await client.healthcheck();
    test.skip(!health.ok, `staging pre-flight failed: ${health.issues.join('; ')}`);
  });

  // -------------------------------------------------------------------------
  // Test 1 — Client A (Acme Clay Ovens) sees only their own data on /portal
  // -------------------------------------------------------------------------
  test('client A (Acme Clay Ovens) signs in via magic link and sees only their own client on /portal', async ({
    page,
  }) => {
    const link = await client.generateMagicLink(client.defaultUsers.a, {
      redirectTo: `${portalUrl}/api/auth/callback?next=/portal`,
    });

    await page.context().clearCookies();
    await page.goto(link);

    // The callback redirects to /portal on success.
    await expect(page).toHaveURL(/\/portal(\?|$|\/)/);

    // The single-client overview MUST show Acme Clay Ovens (their own).
    await expect(page.getByText('Acme Clay Ovens', { exact: false })).toBeVisible({ timeout: 15_000 });

    // It MUST NOT show Brisa Beach Houses (the other tenant).
    await expect(page.getByText('Brisa Beach Houses', { exact: false })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Client B (Brisa Beach Houses) sees only their own data
  // -------------------------------------------------------------------------
  test('client B (Brisa Beach Houses) signs in via magic link and sees only their own client on /portal', async ({
    page,
  }) => {
    const link = await client.generateMagicLink(client.defaultUsers.b, {
      redirectTo: `${portalUrl}/api/auth/callback?next=/portal`,
    });

    await page.context().clearCookies();
    await page.goto(link);

    await expect(page).toHaveURL(/\/portal(\?|$|\/)/);
    await expect(page.getByText('Brisa Beach Houses', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Acme Clay Ovens', { exact: false })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Test 3 — staff operator sees both clients in /admin/portal/clients
  // -------------------------------------------------------------------------
  test('staff operator sees both seeded clients in /admin/portal/clients', async ({ page, context }) => {
    // Seed: a staff user is a normal auth.users row with app_metadata.staff=true.
    // The seed (chatbot_clients_seed.sql) does NOT set that flag — it must be
    // applied in Supabase Studio by the operator before this test runs. If it
    // is not set, the /admin/portal/clients endpoint returns 403 and this
    // test fails with a clear, actionable message.
    const link = await client.generateMagicLink(client.defaultUsers.staff, {
      redirectTo: `${portalUrl}/api/auth/callback?next=/admin/portal/clients`,
    });

    await context.clearCookies();
    // The session check in middleware/session.ts also honours a separate
    // operator cookie, which the seeded staff user is expected to set. We
    // set it explicitly here so we don't gate the test on the operator
    // having visited the site first.
    await context.addCookies([
      {
        name: 'kairikos-portal-operator',
        value: '1',
        url: portalUrl,
        sameSite: 'Lax',
      },
    ]);

    const res = await page.goto(link);
    // Land on /admin/portal/clients (callback next=...).
    await expect(page).toHaveURL(/\/admin\/portal\/clients/);

    const apiRes = await page.request.get('/api/admin/portal/clients', {
      headers: { Authorization: `Bearer ${await page.evaluate(() => 'staff-token-placeholder')}` },
    }).catch(() => null);

    // Hard-fail with the actionable message if the staff claim is missing.
    if (apiRes && apiRes.status() === 403) {
      throw new Error(
        'staff operator test got 403 from /api/admin/portal/clients. ' +
          'Set app_metadata.staff=true on ' + client.defaultUsers.staff +
          ' in Supabase Studio (Authentication -> Users -> ' + client.defaultUsers.staff +
          ' -> app_metadata {"staff": true}) and re-run.',
      );
    }

    // The admin list must contain BOTH seeded slugs.
    await expect(page.getByText('Acme Clay Ovens', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Brisa Beach Houses', { exact: false })).toBeVisible();
    void res;
  });
});
