export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { SelfServiceActions } from '@/components/portal/SelfServiceActions';
import { getSession } from '@/lib/session';
import { resolveClientFromSession, isPortalDevMock } from '@/lib/portal-session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { MOCK_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from '@/lib/portal-data';
import type { ClientProfile } from '@/types/portal';
import { loadClientProfileViaPortalApi } from '@/lib/dashboard-fallback';

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
export default async function PortalDashboardPage() {
  // KAIA-11932 temporary diag — log env vars on every request so we can
  // capture what the page lambda's process.env actually contains. Removed
  // once the env visibility bug is identified.
  console.log(
    '[KAIA-11932][page-env] NEXT_PUBLIC_SUPABASE_URL=%s NEXT_PUBLIC_SUPABASE_ANON_KEY=%s DATABASE_URL=%s DIRECT_URL=%s VERCEL_ENV=%s NODE_ENV=%s isPortalDevMock=%s',
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '<missing>',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? `<set len=${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.length}>` : '<missing>',
    process.env.DATABASE_URL ? `<set len=${process.env.DATABASE_URL.length}>` : '<missing>',
    process.env.DIRECT_URL ? `<set len=${process.env.DIRECT_URL.length}>` : '<missing>',
    process.env.VERCEL_ENV ?? '<missing>',
    process.env.NODE_ENV ?? '<missing>',
    isPortalDevMock(),
  );
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[portal] /portal/dashboard getSession() crashed, treating as no_session:', err);
    redirect('/portal/login');
  }
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  const resolved = await resolveClientFromSession();
  console.log(
    '[KAIA-11932][page-resolve] resolved=%s isPortalDevMock=%s isDatabaseConfigured=%s',
    resolved ? JSON.stringify({ clientId: resolved.clientId, email: resolved.email, source: resolved.source }) : 'null',
    isPortalDevMock(),
    isDatabaseConfigured,
  );
  if (!resolved) {
    redirect('/portal/sin-acceso');
  }
  let clientName = MOCK_CLIENT.companyName;
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline = MOCK_TIMELINE;
  let dataSource: 'prisma' | 'portal_api_fallback' | 'mock_dev' = 'mock_dev';
  if (resolved.source !== 'mock_dev' || isDatabaseConfigured) {
    let prismaError: unknown = null;
    try {
      const [client, count, activities] = await Promise.all([
        prisma.chatbotClient.findUnique({
          where: { id: resolved.clientId },
          select: { companyName: true, name: true, goLiveAt: true },
        }),
        prisma.chatbotConversation.count({ where: { clientId: resolved.clientId } }),
        prisma.chatbotActivity.findMany({
          where: { clientId: resolved.clientId },
          orderBy: { completedAt: 'asc' },
        }),
      ]);
      if (client) {
        clientName = client.companyName ?? client.name;
        goLiveAt = client.goLiveAt?.toISOString() ?? null;
        dataSource = 'prisma';
      } else {
        console.warn(
          '[portal] /portal/dashboard prisma.chatbotClient.findUnique returned null for resolved.clientId=%s (email=%s)',
          resolved.clientId,
          resolved.email,
        );
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
          status: a.completedAt ? 'done' : i === activities.findIndex((x) => !x.completedAt) ? 'current' : 'pending',
        }));
      }
    } catch (err) {
      prismaError = err;
      console.error(
        '[portal] /portal/dashboard prisma fetch threw for clientId=%s email=%s:',
        resolved.clientId,
        resolved.email,
        err,
      );
    }
    // KAIA-11641: when Prisma is broken, route the dashboard data through
    // the same /api/portal/me source that returns the real customer data
    // (because /me uses the same `prisma.chatbotClient.findUnique` shape but
    // it has been observed to succeed where the direct call does not — most
    // likely a schema-drift / relationMode miss). This preserves the
    // "real customer data, not MOCK_CLIENT" contract even when the
    // underlying Prisma query is the failure point.
    if (dataSource !== 'prisma') {
      const profile = await loadClientProfileViaPortalApi();
      if (profile) {
        const fallbackName = profile.companyName ?? profile.contactName ?? '';
        if (fallbackName) {
          clientName = fallbackName;
          goLiveAt = profile.goLiveDate ?? null;
        }
        dataSource = 'portal_api_fallback';
      } else if (prismaError) {
        console.error(
          '[portal] /portal/dashboard prisma + portal_api_fallback both failed for clientId=%s; rendering with mock data',
          resolved.clientId,
        );
      }
    }
  }

  const currentStep = timeline.find((s) => s.status === 'current');
  const completedSteps = timeline.filter((s) => s.status === 'done').length;
  const totalSteps = timeline.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const status = goLiveAt ? 'live' : 'in_progress';

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Dashboard"
        title={clientName}
        description="Aquí verás el estado de tu chatbot y los próximos pasos del onboarding."
        actions={
          <Link href="/portal/support" className="btn-ghost">Contactar soporte</Link>
        }
      />
      <span data-testid="dashboard-client-name" data-dashboard-source={dataSource} hidden>
        {clientName}
      </span>

      <section className="card" aria-label="Estado del chatbot">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Estado del chatbot</h2>
          <span className={status === 'live' ? 'pill-success' : 'pill-warning'}>
            {status === 'live' ? 'En producción' : 'En curso'}
          </span>
        </header>
        <ChatbotStatusCard
          summary={{
            spaceId: MOCK_CHATBOT.spaceId,
            status: status,
            goLiveDate: goLiveAt ?? MOCK_CHATBOT.goLiveDate,
            last7Days: {
              conversations: conversationCount || MOCK_CHATBOT.last7Days.conversations,
              fallbackRate: MOCK_CHATBOT.last7Days.fallbackRate,
              escalationRate: MOCK_CHATBOT.last7Days.escalationRate,
            },
          }}
        />
        <p className="mt-3 text-xs text-kairikos-muted">
          {goLiveAt
            ? `En producción desde el ${DATE_FMT.format(new Date(goLiveAt))}.`
            : 'Tu chatbot aún no está en producción. Te avisaremos por email cuando se active.'}
        </p>
      </section>

      <section className="card" aria-label="Progreso del onboarding">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Onboarding</h2>
          <span className="text-sm text-kairikos-muted" data-testid="onboarding-progress">
            {progressPct}% · paso {Math.min(completedSteps + 1, totalSteps)} de {totalSteps}
          </span>
        </header>
        <OnboardingTimeline rows={timeline} />
        {currentStep ? (
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
