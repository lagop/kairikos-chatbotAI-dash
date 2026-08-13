export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { SelfServiceActions } from '@/components/portal/SelfServiceActions';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isDatabaseConfigured } from '@/lib/prisma';
import { getDashboardData } from '@/lib/dashboard-data';
import { logError } from '@/lib/observability';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Resumen del estado de tu chatbot y del onboarding en Kairikos.',
  alternates: { canonical: '/portal/dashboard' },
  robots: { index: false, follow: false },
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

// KAIA-3920 board-user report (2026-07-23T22:22Z): the unauth-landing panel
// rendered at /portal/dashboard looked like the login page to clients and
// they reported being "stuck on the login page" after login. Other portal
// routes already redirect on no-session; this page did not. Align it with
// the rest of the portal so the unauth contract is uniform across the
// chrome — visiting /portal/dashboard without a session redirects to
// /portal/login (or /portal/sin-acceso for cross-tenant), never renders
// the "Necesitas iniciar sesión" panel.
//
// WP-08 — the page used to own three separate "where does the data come
// from" decisions (direct Prisma, the KAIA-11641 API fallback, the
// dev-mock default) interleaved with the JSX below. All of that now lives
// in getDashboardData(); this component only resolves the session and
// renders whatever it's handed. No mock-vs-real branching happens here.
export default async function PortalDashboardPage() {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    logError('dashboard.get_session', err, { route: '/portal/dashboard' });
    redirect('/portal/login');
  }
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/sin-acceso');
  }

  const data = await getDashboardData(resolved);
  const chatbotProduct = data.products.find((p) => p.product === 'chatbot');
  const chatbotSummary = chatbotProduct?.summary ?? null;
  const status = chatbotSummary?.status ?? 'in-progress';
  const goLiveAt = data.client.goLiveAt;

  const currentStep = data.timeline.find((s) => s.status === 'current');
  const completedSteps = data.timeline.filter((s) => s.status === 'done').length;
  const totalSteps = data.timeline.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  // WP-08 AC — a visitor whose Supabase env looks like dev-mock but whose
  // DATABASE_URL is genuinely configured and reachable is a real
  // half-configured-environment class, not a developer running `next dev`
  // with nothing set up. Surfacing it as a banner (instead of quietly
  // rendering MOCK_CLIENT as if it were real) is the whole point of
  // giving `source` a name the page can branch on.
  const showMockDiagnosticBanner = data.source === 'mock_dev' && isDatabaseConfigured;

  return (
    <div className="space-y-6">
      {showMockDiagnosticBanner ? (
        <div
          className="rounded-xl border border-kairikos-warning/40 bg-kairikos-warning/10 px-4 py-3 text-sm text-kairikos-text"
          role="status"
          data-testid="dashboard-mock-diagnostic-banner"
        >
          <p className="font-semibold">Mostrando datos de ejemplo</p>
          <p className="mt-1 text-kairikos-muted">
            La base de datos está configurada, pero esta sesión no ha podido resolver un cliente real. Un
            operador ya ha sido avisado.
          </p>
        </div>
      ) : null}
      <PageHeading
        eyebrow="Dashboard"
        title={data.client.name}
        description="Aquí verás el estado de tu chatbot y los próximos pasos del onboarding."
        actions={
          <Link href="/portal/support" className="btn-ghost">Contactar soporte</Link>
        }
      />
      <span data-testid="dashboard-client-name" data-dashboard-source={data.source} hidden>
        {data.client.name}
      </span>

      {chatbotSummary ? (
        <section className="card" aria-label="Estado del chatbot">
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Estado del chatbot</h2>
            <span className={status === 'live' ? 'pill-success' : 'pill-warning'}>
              {status === 'live' ? 'En producción' : 'En curso'}
            </span>
          </header>
          <ChatbotStatusCard summary={chatbotSummary} />
          <p className="mt-3 text-xs text-kairikos-muted">
            {goLiveAt
              ? `En producción desde el ${DATE_FMT.format(new Date(goLiveAt))}.`
              : 'Tu chatbot aún no está en producción. Te avisaremos por email cuando se active.'}
          </p>
        </section>
      ) : null}

      <section className="card" aria-label="Progreso del onboarding">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Onboarding</h2>
          <span className="text-sm text-kairikos-muted" data-testid="onboarding-progress">
            {/* KAIA-11955 — for a freshly-signed-up customer with no
                ChatbotActivity rows yet, totalSteps is 0. Render a
                honest "preparing" copy instead of the misleading
                "0% · paso 0 de 0" which the user read as "stuck at
                the T+0 step". */}
            {totalSteps > 0
              ? `${progressPct}% · paso ${Math.min(completedSteps + 1, totalSteps)} de ${totalSteps}`
              : 'Preparando tu portal…'}
          </span>
        </header>
        <OnboardingTimeline rows={data.timeline} />
        {/* KAIA-11955 — when there are no activity rows, the empty
            state inside <OnboardingTimeline /> already explains
            "Aún no hay pasos registrados". The extra reassurance
            below tells the customer *why* (their portal is being
            set up) and *what happens next* (an email) so they do
            not think they are stuck. */}
        {totalSteps === 0 ? (
          <p className="mt-3 text-sm text-kairikos-muted">
            Tu portal está en preparación. Te enviaremos un email cuando
            completemos el primer paso del onboarding.
          </p>
        ) : currentStep ? (
          <p className="mt-3 text-sm text-kairikos-muted">
            Siguiente: <span className="text-kairikos-text">{currentStep.label}</span>
          </p>
        ) : null}
        <p className="mt-2 text-xs text-kairikos-muted">
          <Link className="underline" href="/portal/onboarding">Ver timeline completo →</Link>
        </p>
      </section>

      <SelfServiceActions
        activeMilestoneId={
          currentStep
            ? (currentStep.step === 't_plus_0'
                ? 'T+0'
                : currentStep.step === 't_plus_3'
                  ? 'T+3'
                  : currentStep.step === 't_plus_7'
                    ? 'T+7'
                    : 'T+14')
            : null
        }
        canGoLiveReady={false}
        canMarkAssetsUploaded={false}
        variant="dashboard"
        clientId={session.clientId ?? ''}
        revalidatePath="/portal/dashboard"
      />
    </div>
  );
}
