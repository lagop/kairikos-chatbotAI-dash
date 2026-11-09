import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { PremiumQuoterSettingsPanel } from '@/components/admin/PremiumQuoterSettingsPanel';
import { loadActiveQuoterData } from '@/lib/premium-quoter';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Presupuestador · Admin',
  description: 'Precios, textos y sectores del presupuestador de Web Premium.',
  alternates: { canonical: '/admin/portal/settings/presupuestador' },
  robots: { index: false, follow: false },
};

export default async function AdminPremiumQuoterSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/presupuestador');
  }

  const active = isDatabaseConfigured ? await loadActiveQuoterData(prisma) : null;
  const versions = isDatabaseConfigured
    ? await prisma.premiumQuoterVersion.findMany({
        orderBy: { version: 'desc' },
        take: 15,
        select: { version: true, note: true, operatorEmail: true, createdAt: true },
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Presupuestador de Web Premium"
        description="Lo que ve el visitante en /web-premium. Cada guardado es una versión nueva y se aplica al momento. Los precios de los servicios de Kairikos no se editan aquí: salen del catálogo."
      />
      {active ? (
        <PremiumQuoterSettingsPanel
          initialData={active.data}
          version={active.version}
          versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
        />
      ) : (
        <EmptyState title="No se han podido leer los datos" description="La versión guardada ya no es válida. Mira los registros: premium_quoter.invalid_stored_data." />
      )}
    </div>
  );
}
