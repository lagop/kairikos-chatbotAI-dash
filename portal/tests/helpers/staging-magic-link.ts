// portal/tests/helpers/staging-magic-link.ts
//
// KAIA-740 — staging e2e helper. Bridges a real Supabase magic-link round-trip
// from a CI / heartbeat run where the email never reaches a real inbox.
//
// Why this file exists
// --------------------
// The KAIA-740 acceptance criterion is:
//
//   "End-to-end check: log into the Next.js dev portal as one of the fake
//    clients via magic link, open /portal, confirm only that client is listed."
//
// In a heartbeat there is no human to click the link in an inbox. The Supabase
// admin API exposes `generateLink({ type: 'magiclink' })` which returns the
// same `action_link` value the email would contain, without actually sending
// the email. We POST that link into the browser to land on the real callback
// route the production flow uses.
//
// Reversibility / blast radius
// ----------------------------
// * Read-only: we call `generateLink` and read the response. We do NOT
//   create or delete auth.users here — that responsibility stays in
//   supabase/scripts/apply-to-staging.sh (the Backend Developer's runner).
// * The link is one-shot and expires per Supabase defaults (default 1h, often
//   24h on hosted). Re-running a check just generates a fresh one.
//
// Required env (loaded from the project root .env, NOT from portal/.env):
//   SUPABASE_URL                       e.g. https://abcdefghij.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY          staging service role key
//   PORTAL_URL                         e.g. https://staging--portal.kairikos.com
//
// Optional:
//   STAGING_TEST_USER_A_EMAIL          defaults to onboarding-test1@kairikos.dev
//   STAGING_TEST_USER_B_EMAIL          defaults to onboarding-test2@kairikos.dev
//   STAGING_TEST_USER_STAFF_EMAIL      defaults to staff-test@kairikos.dev
//                                      (must be pre-promoted to staff via
//                                       app_metadata.staff=true in Supabase
//                                       Studio; this helper does NOT set it).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface MagicLinkOptions {
  /** Where to redirect after the link is consumed. Defaults to PORTAL_URL. */
  redirectTo?: string;
  /** The seeded test users we will try to log in as. */
  users?: {
    a?: string;
    b?: string;
    staff?: string;
  };
}

export interface StagingMagicLinkClient {
  /** Resolves with the action_link you can `page.goto()` to complete the flow. */
  generateMagicLink(email: string, opts?: { redirectTo?: string }): Promise<string>;
  /** The default seeded test users. */
  defaultUsers: {
    a: string;
    b: string;
    staff: string;
  };
  /** Pre-flight: verify the admin client can see auth.users and our seed tenants. */
  healthcheck(): Promise<{
    ok: boolean;
    authUserCount: number;
    clientCount: number;
    issues: string[];
  }>;
}

const DEFAULT_USERS = {
  a: 'onboarding-test1@kairikos.dev',
  b: 'onboarding-test2@kairikos.dev',
  staff: 'staff-test@kairikos.dev',
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `staging-magic-link: required env var ${name} is not set. ` +
        `Copy .env.example to .env and fill in the staging values.`,
    );
  }
  return v;
}

export function createStagingMagicLinkClient(
  env: NodeJS.ProcessEnv = process.env,
): StagingMagicLinkClient {
  const url = requireEnv.call(null, 'SUPABASE_URL');
  const serviceKey = requireEnv.call(null, 'SUPABASE_SERVICE_ROLE_KEY');
  const portalUrl = requireEnv.call(null, 'PORTAL_URL');

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const defaultUsers = {
    a: env.STAGING_TEST_USER_A_EMAIL ?? DEFAULT_USERS.a,
    b: env.STAGING_TEST_USER_B_EMAIL ?? DEFAULT_USERS.b,
    staff: env.STAGING_TEST_USER_STAFF_EMAIL ?? DEFAULT_USERS.staff,
  };

  return {
    defaultUsers,
    async generateMagicLink(email, opts) {
      const redirectTo = opts?.redirectTo ?? portalUrl;
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo },
      });
      if (error) {
        throw new Error(
          `staging-magic-link: generateLink failed for ${email}: ${error.message}`,
        );
      }
      const link = data?.properties?.action_link;
      if (!link) {
        throw new Error(
          `staging-magic-link: generateLink returned no action_link for ${email}`,
        );
      }
      return link;
    },
    async healthcheck() {
      const issues: string[] = [];
      let authUserCount = 0;
      let clientCount = 0;
      try {
        const { count, error: userErr } = await admin
          .from('auth.users' as never)
          .select('id', { count: 'exact', head: true });
        if (userErr) {
          issues.push(`auth.users probe failed: ${userErr.message}`);
        } else {
          authUserCount = count ?? 0;
        }
      } catch (e) {
        issues.push(`auth.users probe threw: ${(e as Error).message}`);
      }
      try {
        const { count, error: clientErr } = await admin
          .from('chatbot_clients' as never)
          .select('id', { count: 'exact', head: true });
        if (clientErr) {
          issues.push(`chatbot_clients probe failed: ${clientErr.message}`);
        } else {
          clientCount = count ?? 0;
        }
      } catch (e) {
        issues.push(`chatbot_clients probe threw: ${(e as Error).message}`);
      }
      if (clientCount < 2) {
        issues.push(
          `expected >= 2 chatbot_clients rows (the seed has 2); found ${clientCount}. ` +
            `Did supabase/scripts/apply-to-staging.sh run successfully?`,
        );
      }
      return { ok: issues.length === 0, authUserCount, clientCount, issues };
    },
  };
}
