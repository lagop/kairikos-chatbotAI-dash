import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { getPortalContext } from '@/lib/portal-data';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const PUBLIC_PORTAL_PREFIXES = [
  '/portal/login',
  '/portal/sin-acceso',
  '/portal/setup-password',
  '/portal/forgot-password',
  '/portal/reset-password',
  '/api/auth',
];

function isPublicPortalPath(pathname: string): boolean {
  return PUBLIC_PORTAL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function PortalLayoutShell({ children, email, businessName }: { children: ReactNode; email: string | undefined; businessName: string | undefined }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader email={email} businessName={businessName} />
      <main id="contenido" className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
      <PortalFooter />
      <PageViewTracker />
    </div>
  );
}

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? '';

  if (isPublicPortalPath(pathname)) {
    return <PortalLayoutShell email={undefined} businessName={undefined}>{children}</PortalLayoutShell>;
  }

  let session;
  try {
    session = await getSession();
  } catch {
    session = { hasClientAccess: false, reason: 'no_session', email: undefined, accessToken: undefined };
  }

  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }

  let businessName: string | undefined;
  if (session.accessToken) {
    try {
      const ctx = await getPortalContext(session.accessToken);
      businessName = ctx.client.companyName;
    } catch {
      businessName = undefined;
    }
  }
  return (
    <PortalLayoutShell email={session.email} businessName={businessName}>{children}</PortalLayoutShell>
  );
}
