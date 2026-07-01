import type { ReactNode } from 'react';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';

export const dynamic = 'force-dynamic';

// KAIA-2808 / KAIA-2854 — previous versions of this layout called
// `headers()` and `getSession()` to gate child rendering. That caused
// every `/portal/*` and `/admin/portal/*` route to return HTTP 500
// during SSR on Vercel (the runtime error has been confirmed via the
// Vercel build manifest: no App Router chunks are emitted for
// segments wrapped in this layout).
//
// The fix is to drop ALL session/headers logic from the layout.
// Each page that requires a session already calls
// `requirePortalSession()` from `@/lib/session` directly, so the
// protection is preserved at the page level. Public auth pages
// (`/portal/login`, `/portal/setup-password`, etc.) just render the
// auth UI without a session check — which is exactly what we want
// anyway.
//
// The layout still provides the chrome (header/footer) so the visual
// shell is consistent across the portal.
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader email={null} businessName={undefined} />
      <main id="contenido" className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
      <PortalFooter />
      <PageViewTracker />
    </div>
  );
}