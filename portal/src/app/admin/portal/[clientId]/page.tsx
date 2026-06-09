import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from '@/lib/portal-data';

interface PageProps {
  params: { clientId: string };
}

const MILESTONE_LABEL: Record<string, string> = {
  'T+0': 'Bienvenida y acceso al portal',
  'T+3': 'Configuración inicial',
  'T+7': 'Puesta en producción',
  'T+14': 'Revisión y optimización',
};

const MILESTONE_STEP: Record<string, 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: `Cliente ${params.clientId.slice(0, 8)} · Operador`,
    description: 'Vista de sólo lectura del portal de un cliente concreto.',
    alternates: { canonical: `/admin/portal/${params.clientId}` },
    robots: { index: false, follow: false },
  };
}

export default async function AdminClientDetailPage({ params }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/${encodeURIComponent(params.clientId)}`);
  }
  let companyName = 'Cliente';
  let email = '';
  let tier = 'starter';
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline = MOCK_TIMELINE;
  if (isDatabaseConfigured) {
    try {
      const client = await prisma.chatbotClient.findUnique({
        where: { id: params.clientId },
        select: {
          id: true,
          companyName: true,
          name: true,
          email: true,
          tier: true,
          goLiveAt: true,
        },
      });
      if (client) {
        companyName = client.companyName ?? client.name;
        email = client.email;
        tier = client.tier;
        goLiveAt = client.goLiveAt?.toISOString() ?? null;
        const [count, activities] = await Promise.all([
          prisma.chatbotConversation.count({ where: { clientId: client.id } }),
          prisma.chatbotActivity.findMany({
            where: { clientId: client.id },
            orderBy: { completedAt: 'asc' },
          }),
        ]);
        conversationCount = count;
        if (activities.length > 0) {
          timeline = activities.map((a, i, arr) => {
            const isFirstPending = !a.completedAt && arr.findIndex((x) => !x.completedAt) === i;
            return {
              id: a.id,
              step: MILESTONE_STEP[a.milestone] ?? 't_plus_0',
              label: MILESTONE_LABEL[a.milestone] ?? a.milestone,
              description: a.notes ?? '',
              occurredAt: a.completedAt?.toISOString() ?? null,
              status: a.completedAt ? 'done' as const : isFirstPending ? 'current' as const : 'pending' as const,
            };
          });
        }
      } else {
        notFound();
      }
    } catch {
      // fall back to mock lookup
    }
  }
  // Mock fallback: match by id from the two seeded mock clients
  if (companyName === 'Cliente') {
    const mockMatch = [MOCK_CLIENT, MOCK_SECONDARY_CLIENT].find((m) => m.id === params.clientId);
    if (mockMatch) {
      companyName = mockMatch.companyName;
      email = mockMatch.primaryContactEmail;
      tier = mockMatch.tier;
      goLiveAt = mockMatch.goLiveDate;
    } else {
      notFound();
    }
  }

  const status: 'live' | 'in_progress' = goLiveAt ? 'live' : 'in_progress';

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal" className="hover:text-kairikos-text">← Volver al listado</Link>
      </div>
      <PageHeading
        eyebrow="Operador · vista de cliente"
        title={companyName}
        description={`${email} · Plan ${tier} · Vista de sólo lectura`}
        actions={
          <span
            data-testid="operator-readonly-badge"
            className="pill-warning"
          >
            Modo lectura
          </span>
        }
      />

      <section className="card" aria-label="Estado del chatbot del cliente">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Estado del chatbot</h2>
          <span className={status === 'live' ? 'pill-success' : 'pill-warning'}>
            {status === 'live' ? 'En producción' : 'En curso'}
          </span>
        </header>
        <ChatbotStatusCard
          summary={{
            spaceId: MOCK_CHATBOT.spaceId,
            status,
            goLiveDate: goLiveAt ?? MOCK_CHATBOT.goLiveDate,
            last7Days: {
              conversations: conversationCount || MOCK_CHATBOT.last7Days.conversations,
              fallbackRate: MOCK_CHATBOT.last7Days.fallbackRate,
              escalationRate: MOCK_CHATBOT.last7Days.escalationRate,
            },
          }}
        />
      </section>

      <section className="card" aria-label="Onboarding del cliente">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Onboarding</h2>
        </header>
        <OnboardingTimeline rows={timeline} />
      </section>

      <p className="text-xs text-kairikos-muted">
        Esta vista replica el portal del cliente sin posibilidad de modificar datos.
        Para soporte, accede a la{' '}
        <Link href="/admin/portal" className="underline">lista de clientes</Link>.
      </p>
    </div>
  );
}
