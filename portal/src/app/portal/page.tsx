import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { MOCK_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from '@/lib/portal-data';
import { assertSameClient, getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { loadClientProfileViaPortalApi } from '@/lib/dashboard-fallback';
import type { ChatbotStatusSummary } from '@/types/portal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Resumen',
  description: 'Estado del onboarding, del chatbot y próximas acciones en tu portal Kairikos.',
  alternates: { canonical: '/portal' },
  robots: { index: false, follow: false },
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

export default async function PortalHome({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  // KAIA-2857 — call getSession() and translate "no access" into a redirect
  // locally so any throw from requirePortalSession() never escapes the page.
  // On Vercel, getSession() catches auth()/Prisma init failures and returns
  // { reason: 'no_session' } which we forward to /portal/login (or
  // /portal/sin-acceso for cross-tenant). This keeps /portal returning 200/307
  // instead of the Vercel-rendered 500 pages/_error fallback.
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[portal] /portal getSession() crashed, treating as no_session:', err);
    redirect('/portal/login');
  }
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  assertSameClient(session, searchParams.client ?? null);

  // KAIA-11955 — round 5: query Prisma directly instead of going
  // through getPortalContext(). The previous helper-based path
  // required a self-call to /api/portal/... from the server-side
  // page, which on Vercel intermittently failed to authenticate
  // the NextAuth JWT cookie, so the helpers fell back to the
  // MOCK fixtures (spc_acme_corp, 142 conversaciones, etc.) for
  // every signed-in customer. Querying Prisma here — same as
  // /portal/dashboard already does — keeps the data layer in one
  // place and removes the self-call failure mode entirely.
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/sin-acceso');
  }

  let client = {
    id: resolved.clientId,
    companyName: MOCK_CLIENT.companyName,
    // @ts-expect-error WP-01/WP-08 — the UI's client shape wants `name`, the
    // Prisma-backed ChatbotClient type doesn't have it. WP-08's single
    // dashboard-data function resolves this properly.
    name: MOCK_CLIENT.name,
    tier: 'starter' as string,
    createdAt: new Date(0).toISOString(),
  };
  let timeline: typeof MOCK_TIMELINE = [];
  let conversationCount = 0;
  let goLiveAt: string | null = null;
  const isDevMockMode = resolved.source === 'mock_dev' && !isDatabaseConfigured;

  if (!isDevMockMode) {
    try {
      const [clientRow, activities, count] = await Promise.all([
        prisma.chatbotClient.findUnique({
          where: { id: resolved.clientId },
          select: {
            id: true,
            companyName: true,
            name: true,
            tier: true,
            createdAt: true,
            goLiveAt: true,
          },
        }),
        prisma.chatbotActivity.findMany({
          where: { clientId: resolved.clientId },
          orderBy: { completedAt: 'asc' },
        }),
        prisma.chatbotConversation.count({ where: { clientId: resolved.clientId } }),
      ]);
      if (clientRow) {
        client = {
          id: clientRow.id,
          companyName: clientRow.companyName ?? MOCK_CLIENT.companyName,
          // @ts-expect-error WP-01/WP-08 — see the `name` note above; same
          // ChatbotClient/UI shape mismatch, resolved by WP-08.
          name: clientRow.name ?? MOCK_CLIENT.name,
          tier: clientRow.tier,
          createdAt: clientRow.createdAt.toISOString(),
        };
        goLiveAt = clientRow.goLiveAt?.toISOString() ?? null;
      }
      conversationCount = count;
      if (activities.length > 0) {
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
        timeline = activities.map((a, i) => ({
          id: a.id,
          step: MILESTONE_STEP[a.milestone] ?? 't_plus_0',
          label: MILESTONE_LABEL[a.milestone] ?? a.milestone,
          description: a.notes ?? '',
          occurredAt: a.completedAt?.toISOString() ?? null,
          status: a.completedAt
            ? 'done'
            : i === activities.findIndex((x) => !x.completedAt)
              ? 'current'
              : 'pending',
        }));
      }
    } catch (err) {
      console.error('[portal] /portal Prisma fetch failed:', err);
      // KAIA-11641: try the API fallback so the heading still resolves
      // to a real customer record even if the direct Prisma call throws.
      const profile = await loadClientProfileViaPortalApi();
      if (profile) {
        client = {
          id: resolved.clientId,
          companyName: profile.companyName ?? MOCK_CLIENT.companyName,
          // @ts-expect-error WP-01/WP-08 — see the `name` note above; same
          // ChatbotClient/UI shape mismatch, resolved by WP-08.
          name: profile.contactName ?? MOCK_CLIENT.name,
          tier: profile.tier,
          createdAt: profile.createdAt,
        };
        if (profile.goLiveDate) {
          goLiveAt = profile.goLiveDate;
        }
      }
    }
  } else {
    client = {
      id: MOCK_CLIENT.id,
      companyName: MOCK_CLIENT.companyName,
      // @ts-expect-error WP-01/WP-08 — see the `name` note above; same
      // ChatbotClient/UI shape mismatch, resolved by WP-08.
      name: MOCK_CLIENT.name,
      tier: MOCK_CLIENT.tier,
      createdAt: MOCK_CLIENT.createdAt,
    };
    timeline = MOCK_TIMELINE;
  }

  const chatbotSummary: ChatbotStatusSummary = isDevMockMode
    ? MOCK_CHATBOT
    : {
        spaceId: `spc_${client.id}`,
        status: goLiveAt ? 'live' : 'in-progress',
        goLiveDate: goLiveAt,
        last7Days: {
          conversations: conversationCount,
          fallbackRate: 0,
          escalationRate: 0,
        },
      };

  const currentStep = timeline.find((s) => s.status === 'current');
  const completedSteps = timeline.filter((s) => s.status === 'done').length;
  const totalSteps = timeline.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Hola, buenas tardes"
        title={client.companyName}
        description={`Tu portal de cliente. Aquí verás el estado de tu chatbot y los próximos pasos del onboarding.`}
        actions={
          <Link href="/portal/support" className="btn-ghost">
            Contactar soporte
          </Link>
        }
      />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-label="Indicadores clave">
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Plan</p>
          <p className="mt-1 text-lg font-semibold capitalize">{client.tier}</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            Cliente desde el {DATE_FMT.format(new Date(client.createdAt))}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Onboarding</p>
          {/* KAIA-11955 — render a clear "preparing" copy when the
              customer has no ChatbotActivity rows yet, instead of the
              misleading "0% completado / 0 de 0 pasos" which the user
              read as "stuck at the T+0 step". */}
          {totalSteps > 0 ? (
            <>
              <p className="mt-1 text-lg font-semibold">{progressPct}% completado</p>
              <p className="mt-1 text-xs text-kairikos-muted">
                {completedSteps} de {totalSteps} pasos
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold">Preparando tu portal</p>
              <p className="mt-1 text-xs text-kairikos-muted">
                Te avisaremos por email cuando completemos el primer paso.
              </p>
            </>
          )}
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Chatbot</p>
          <p className="mt-1 text-lg font-semibold">
            {chatbotSummary.status === 'live' ? 'En producción' : 'Pendiente'}
          </p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {chatbotSummary.last7Days.conversations} conversaciones en los últimos 7 días
          </p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card" aria-labelledby="onboarding-resumen">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="onboarding-resumen" className="text-lg font-semibold">
              Onboarding
            </h2>
            <Link href="/portal/onboarding" className="text-sm text-kairikos-accent2 hover:underline">
              Ver todo
            </Link>
          </div>
          {currentStep ? (
            <p className="mb-4 text-sm text-kairikos-muted">
              <span className="pill-warning mr-2">En curso</span>
              {currentStep.label}
            </p>
          ) : null}
          <OnboardingTimeline rows={timeline.slice(0, 4)} />
        </section>

        <ChatbotStatusCard summary={chatbotSummary} />

        <section
          className="card"
          aria-labelledby="resenas-resumen"
          data-testid="resenas-summary-card"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 id="resenas-resumen" className="text-lg font-semibold">
              Reseñas de Google
            </h2>
            <span className="pill-muted">No incluido</span>
          </div>
          <p className="text-sm text-kairikos-muted">
            La gestión de reseñas de Google no está incluida en tu plan actual.
            Si quieres añadirla a tu cuenta, escríbenos y te contamos las opciones disponibles.
          </p>
          <Link
            href="/portal/resenas"
            className="mt-4 inline-flex items-center gap-2 text-sm text-kairikos-accent2 hover:underline"
            data-testid="resenas-summary-link"
          >
            Ver detalles →
          </Link>
        </section>
      </div>
    </div>
  );
}
