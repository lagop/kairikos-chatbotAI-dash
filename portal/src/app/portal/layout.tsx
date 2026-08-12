import type { ReactNode } from 'react';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PortalSidebarMount } from '@/components/portal/PortalSidebarMount';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { auth } from '../../../auth';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { MOCK_CLIENT, DEV_MOCK_CLIENT_BY_EMAIL } from '@/lib/portal-data';

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
// chrome with the user's email. We catch every error and fall back to
// an anonymous chrome so a misconfigured Supabase env cannot 500 the
// layout. Public auth pages still render without a session — the
// page-level guard handles the redirect. The `auth()` fallback below
// covers a signed-in NextAuth session that isn't linked to a
// ChatbotClientUser row (e.g. an operator) — getSession() reports
// hasClientAccess: false for that case, but the chrome should still
// show who's signed in.
//
// WP-04 — businessName used to come from `prisma.portalContext`, a
// model that doesn't exist in schema.prisma (any lookup always threw
// and was silently swallowed, so the company name never rendered for
// anyone). Resolved through the same `resolveClientFromSession()` path
// the client-facing dashboard pages already use instead.
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
      const resolved = await resolveClientFromSession();
      if (resolved) {
        if (isDatabaseConfigured && resolved.source !== 'mock_dev') {
          const client = await prisma.chatbotClient.findUnique({
            where: { id: resolved.clientId },
            select: { companyName: true },
          });
          businessName = client?.companyName ?? undefined;
        } else {
          const mock = DEV_MOCK_CLIENT_BY_EMAIL.get(resolved.email.toLowerCase()) ?? MOCK_CLIENT;
          businessName = mock.companyName ?? undefined;
        }
      }
    }
  } catch (err) {
    console.error('[portal] layout session lookup crashed:', err);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader email={email} businessName={businessName} />
      <div className="mx-auto flex w-full max-w-page flex-1">
        <PortalSidebarMount />
        <main id="contenido" className="w-full flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
      <PortalFooter />
      <PageViewTracker />
    </div>
  );
}
