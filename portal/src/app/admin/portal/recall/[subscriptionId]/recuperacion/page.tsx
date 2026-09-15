import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { RecoveryImportCard } from '@/components/admin/RecoveryImportCard';
import {
  RecoveryCampaignsCard,
  type TriggerPreview,
  type CampaignView,
} from '@/components/admin/RecoveryCampaignsCard';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { findRecoveryCandidates, type RecoveryTrigger } from '@/lib/recovery-triggers';
import { listCampaignsForSubscription } from '@/lib/recovery-campaigns';
import { loadRecallSubscription } from '@/lib/recall-recovery-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Recuperación de clientes · Admin',
  robots: { index: false, follow: false },
};

// =============================================================================
// La parte de recuperación de `recall` para UN cliente.
//
// Es la puerta de entrada que le faltaba a todo lo construido en las fases
// 3 y 4: los disparadores, las campañas y el importador existían y estaban
// desplegados, pero no había ninguna forma de usarlos. El cron de envío
// corría cada cinco minutos sin encontrar nunca nada aprobado, porque no
// había dónde aprobar.
//
// VIVE DENTRO DE `recall`, NO ES UN PRODUCTO. No comprueba ningún producto
// contratado aparte: tener una suscripción de `recall` es tener esto. Así
// se decidió (ver la memoria de decisiones de recall).
//
// Los recuentos de arriba son EN SECO: findRecoveryCandidates no escribe
// nada, así que abrir esta página cuantas veces haga falta no crea
// campañas ni le escribe a nadie.
// =============================================================================

const TRIGGERS: readonly RecoveryTrigger[] = ['open_quote', 'service_anniversary', 'dormant'];

interface Params {
  params: { subscriptionId: string };
}

export default async function RecallRecoveryPage({ params }: Params) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/recall/${params.subscriptionId}/recuperacion`);
  }

  if (!isDatabaseConfigured) {
    return <EmptyState title="Modo de demostración" description="Esta vista necesita una base de datos configurada." />;
  }

  const subscription = await loadRecallSubscription(prisma, params.subscriptionId);
  if (!subscription) notFound();

  const client = await prisma.chatbotClient.findUnique({
    where: { id: subscription.clientId },
    select: { name: true, companyName: true },
  });

  const previews: TriggerPreview[] = await Promise.all(
    TRIGGERS.map(async (trigger) => {
      const run = await findRecoveryCandidates(prisma, {
        clientId: subscription.clientId,
        subscriptionId: subscription.id,
        triggers: [trigger],
      });
      const excluded: Record<string, number> = {};
      for (const e of run.excluded) excluded[e.reason] = (excluded[e.reason] ?? 0) + 1;
      return { trigger, candidates: run.candidates.length, excluded };
    }),
  );

  const campaigns: CampaignView[] = (await listCampaignsForSubscription(prisma, subscription.id)).map((c) => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    approvedAt: c.approvedAt?.toISOString() ?? null,
  }));

  const name = client?.companyName ?? client?.name ?? 'Cliente';

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href={`/admin/portal/${subscription.clientId}?product=recall`} className="hover:text-kairikos-text">
          ← Volver a {name}
        </Link>
      </div>

      <PageHeading
        eyebrow="Recuperación de llamadas"
        title={`Recuperación de clientes · ${name}`}
        description="Importar su histórico y decidir a quién volver a escribir. Nada se envía sin que lo apruebes."
      />

      <RecoveryImportCard subscriptionId={subscription.id} />
      <RecoveryCampaignsCard subscriptionId={subscription.id} previews={previews} campaigns={campaigns} />
    </div>
  );
}
