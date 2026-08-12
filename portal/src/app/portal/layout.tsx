import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { LogoutButton } from '@/components/portal/LogoutButton';
import { auth } from '../../../auth';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

// KAIA-2808 / KAIA-2854 — previous versions of this layout called
// `headers()` and `getSession()` to gate child rendering. That caused
// every `/portal/*` and `/admin/portal/*` route to return HTTP 500
// during SSR on Vercel. The fix was to drop session/headers logic
// from the layout and let each page call `requirePortalSession()`
// directly.
//
// KAIA-3921 — we now call `getSession()` (the safe variant that
// returns `{ hasClientAccess: false }` on any throw) to enrich the
// chrome with the user's email and a logout button. We catch every
// error and fall back to an anonymous chrome so a misconfigured
// Supabase env cannot 500 the layout. Public auth pages still render
// without a session — the page-level guard handles the redirect.
//
// KAIA-4011 (production promotion) — also resolve `businessName` via the
// operator-cookie access-token path that main carried so the operator
// portal chrome still surfaces the company name on the dashboard.
export default async function PortalLayout({ children }: { children: ReactNode }) {
  let email: string | null = null;
  let businessName: string | undefined;

  try {
    const session = await getSession();
    if (session.hasClientAccess && session.email) {
      email = session.email;
    } else {
      const nextAuthSession = await auth();
      if (nextAuthSession?.user?.email) {
        email = nextAuthSession.user.email;
      }
    }

    if (email) {
      const cookieStore = cookies();
      const operatorCookie = cookieStore.get('kairikos-portal-operator');
      const accessToken = operatorCookie?.value;

      if (accessToken) {
        try {
          // @ts-expect-error WP-01/WP-04 — no PortalContext model exists in
          // schema.prisma; this call always throws and is swallowed below.
          // WP-04 decides whether to resolve businessName from
          // ChatbotClient.companyName or remove this block entirely.
          const ctx = await prisma.portalContext.findFirst({
            where: { accessToken },
            include: { client: { select: { companyName: true } } },
          });
          businessName = ctx?.client?.companyName ?? undefined;
        } catch {
          businessName = undefined;
        }
      }
    }
  } catch (err) {
    console.error('[portal] layout session lookup crashed:', err);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader
        email={email}
        businessName={businessName}
        // @ts-expect-error WP-01/WP-04 — PortalHeader doesn't declare a
        // userMenu prop; WP-04 either wires it up for real or drops it.
        userMenu={
          email ? (
            <LogoutButton
              className="btn-ghost hidden text-xs sm:inline-flex"
              label="Cerrar sesión"
              pendingLabel="Cerrando…"
              testId="header-logout"
            />
          ) : null
        }
      />
      <main id="contenido" className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
      <PortalFooter />
      <PageViewTracker />
    </div>
  );
}
