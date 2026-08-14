import 'server-only';
import { cookies } from 'next/headers';
import { auth } from '../../auth';
import { prisma, isDatabaseConfigured } from './prisma';
import { MOCK_CLIENT, DEV_MOCK_CLIENT_BY_EMAIL } from './portal-data';

export interface ResolvedClient {
  clientId: string;
  email: string;
  source: 'database' | 'mock_dev';
}

// KAIA-1519 — the single dev-mock detector. `session.ts`'s getSession()
// imports this too (WP-06) instead of keeping its own copy; previously
// `isSupabaseConfigured` (truthy URL + key) and `isDevMock` (placeholder
// URL) diverged, leaving the wizard page redirected to /portal/login even
// when the layout was happy with the mock session.
//
// We accept the same placeholder URL that ships in `.env` (`placeholder.supabase.co`)
// and the explicit `YOUR-PROJECT` / `invalid.supabase.co` markers so the
// test runner can boot the dev-mock mode without having to override the
// Supabase env vars.
export function isPortalDevMock(): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return true;
  if (supabaseUrl.includes('YOUR-PROJECT')) return true;
  if (supabaseUrl === 'https://invalid.supabase.co') return true;
  if (supabaseUrl.includes('placeholder.supabase.co')) return true;
  if (supabaseKey === 'placeholder' || supabaseKey === 'placeholder-key') return true;
  return false;
}

async function resolveFromSupabaseEmail(email: string): Promise<ResolvedClient | null> {
  if (isPortalDevMock()) {
    // KAIA-1519 — dev-mock resolution now consults a lookup table that
    // includes the MOCK_CLIENT (pro) and MOCK_SECONDARY_CLIENT (premium)
    // fixtures plus the new MOCK_STARTER_CLIENT. Test runners can switch
    // tiers by setting the `kairikos-portal-dev-email` cookie to the
    // matching dev email.
    const mock = DEV_MOCK_CLIENT_BY_EMAIL.get(email.toLowerCase());
    if (mock) {
      return { clientId: mock.id, email, source: 'mock_dev' };
    }
    return null;
  }
  if (!isDatabaseConfigured) {
    return null;
  }
  const link = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: email.toLowerCase() },
    select: { clientId: true },
  });
  if (!link) return null;
  return { clientId: link.clientId, email, source: 'database' };
}

export async function resolveClientFromSession(): Promise<ResolvedClient | null> {
  // A real, valid NextAuth session always takes priority over the
  // dev-mock fallback below. `isPortalDevMock()` detects whether
  // Supabase env vars look configured — a leftover check from before
  // this portal's client login moved to NextAuth Credentials, unrelated
  // to whether there's a real, authenticated session right now. Gating
  // on it first (as this function used to) meant that in any
  // environment with placeholder Supabase vars — e.g. local dev, where
  // Supabase isn't used for auth at all — a genuinely logged-in client
  // would silently see MOCK_CLIENT's data instead of their own, with no
  // way to reach their real account through the actual login form.
  if (isDatabaseConfigured) {
    const session = await auth();
    const email = session?.user?.email?.toLowerCase().trim();
    if (email) {
      const link = await prisma.chatbotClientUser.findUnique({
        where: { nextAuthEmail: email },
        select: { clientId: true },
      });
      if (link) {
        return { clientId: link.clientId, email, source: 'database' };
      }
      // Real session, but no matching client row (e.g. an operator
      // session, or a stale/orphaned NextAuth session). Outside dev-mock
      // this must resolve to "not a client", not silently fall through
      // to a mock — dev-mock stays lenient below so local tooling keeps
      // degrading to something demoable.
      if (!isPortalDevMock()) return null;
    }
  }

  if (!isPortalDevMock()) {
    return null;
  }
  // Dev fallback: trust an explicit dev-email cookie set by Playwright /
  // local tools. If absent, fall back to the mock client so the UI is
  // always demoable.
  const devEmail = cookies().get('kairikos-portal-dev-email')?.value;
  if (devEmail) {
    return resolveFromSupabaseEmail(devEmail);
  }
  return { clientId: MOCK_CLIENT.id, email: MOCK_CLIENT.primaryContactEmail, source: 'mock_dev' };
}

