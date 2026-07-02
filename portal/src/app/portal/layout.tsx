import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PageViewTracker } from '@/components/portal/PageViewTracker';
import { auth } from '../../../auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function PortalLayout({ children }: { children: ReactNode }) {
  let email: string | null = null;
  let businessName: string | undefined;

  try {
    const session = await auth();
    if (session?.user?.email) {
      email = session.user.email;

      const cookieStore = cookies();
      const operatorCookie = cookieStore.get('kairikos-portal-operator');
      const accessToken = operatorCookie?.value;

      if (accessToken) {
        try {
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
  } catch {
    email = null;
  }

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