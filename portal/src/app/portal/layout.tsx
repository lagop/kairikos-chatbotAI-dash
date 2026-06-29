import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { getPortalContext } from '@/lib/portal-data';
import { getSession, type PortalSession } from '@/lib/session';

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

async function resolveBusinessName(session: PortalSession): Promise<string | undefined> {
  if (!session.accessToken) return undefined;
  try {
    const ctx = await getPortalContext(session.accessToken);
    return ctx.client.companyName;
  } catch {
    return undefined;
  }
}

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? '';
  if (isPublicPortalPath(pathname)) {
    return (
      <div className="flex min-h-screen flex-col">
        <PortalHeader email={null} businessName={undefined} />
        <main id="contenido" className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
        <PortalFooter />
      </div>
    );
  }
  const session = await getSession();
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  const businessName = await resolveBusinessName(session);
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader email={session.email} businessName={businessName} />
      <main id="contenido" className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
      <PortalFooter />
      <PageViewTracker />
    </div>
  );
}
