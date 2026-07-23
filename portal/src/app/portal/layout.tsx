import type { ReactNode } from 'react';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { LogoutButton } from '@/components/portal/LogoutButton';
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
export default async function PortalLayout({ children }: { children: ReactNode }) {
  let email: string | null = null;
  try {
    const session = await getSession();
    if (session.hasClientAccess && session.email) {
      email = session.email;
    }
  } catch (err) {
    console.error('[portal] layout getSession() crashed:', err);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader
        email={email}
        businessName={undefined}
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