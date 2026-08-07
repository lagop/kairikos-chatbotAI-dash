import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { getPortalContext } from '@/lib/portal-data';
import { assertSameClient, getSession } from '@/lib/session';

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
  let ctx;
  try {
    ctx = await getPortalContext(session.accessToken ?? '');
  } catch (err) {
    console.error('[portal] /portal getPortalContext() crashed, redirecting to support:', err);
    redirect('/portal/support');
  }

  const currentStep = ctx.onboarding.find((s) => s.status === 'current');
  const completedSteps = ctx.onboarding.filter((s) => s.status === 'done').length;
  const totalSteps = ctx.onboarding.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Hola, buenas tardes"
        title={ctx.client.companyName}
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
          <p className="mt-1 text-lg font-semibold capitalize">{ctx.client.tier}</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            Cliente desde el {DATE_FMT.format(new Date(ctx.client.createdAt))}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Onboarding</p>
          <p className="mt-1 text-lg font-semibold">{progressPct}% completado</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {completedSteps} de {totalSteps} pasos
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Chatbot</p>
          <p className="mt-1 text-lg font-semibold">
            {ctx.chatbot.status === 'live' ? 'En producción' : 'Pendiente'}
          </p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {ctx.chatbot.last7Days.conversations} conversaciones en los últimos 7 días
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
          <OnboardingTimeline rows={ctx.onboarding.slice(0, 4)} />
        </section>

        <ChatbotStatusCard summary={ctx.chatbot} />

        <section
          className="card"
          aria-labelledby="resenas-resumen"
          data-testid="resenas-summary-card"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 id="resenas-resumen" className="text-lg font-semibold">
              Reseñas de Google
            </h2>
            <span className="pill-muted">Pronto</span>
          </div>
          <p className="text-sm text-kairikos-muted">
            Pronto podrás ver y responder tus reseñas de Google desde el portal. Estamos preparando la integración con Google Business Profile en la fase 2 del Dashboard v2.
          </p>
          <Link
            href="/portal/resenas"
            className="mt-4 inline-flex items-center gap-2 text-sm text-kairikos-accent2 hover:underline"
            data-testid="resenas-summary-link"
          >
            Ver la sección de Reseñas →
          </Link>
        </section>
      </div>
    </div>
  );
}
