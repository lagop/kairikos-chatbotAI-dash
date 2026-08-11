import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { EmptyState } from '@/components/portal/EmptyState';
import { OperatorEditor } from '@/components/portal/OperatorEditor';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { prismaDirect, isDatabaseDirectConfigured } from '@/lib/prisma-direct';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_TIMELINE } from '@/lib/portal-data';
import type { OnboardingTimelineRow } from '@/types/portal';
import { MOCK_FLOW_ACTIVITY, MOCK_N8N_EXECUTIONS, type FlowActivityEntry, type N8nExecutionSummary } from '@/lib/flow-health';
import { buildAdminClientChatbotStatus } from '@/lib/chatbot-status';
import { advanceOnboardingMilestone } from './onboarding-actions';
import { ALLOWED_MILESTONES } from './onboarding-constants';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { clientId: string };
  searchParams: { tab?: string };
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

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: `Cliente ${params.clientId.slice(0, 8)} · Operador`,
    description: 'Vista de sólo lectura del portal de un cliente concreto.',
    alternates: { canonical: `/admin/portal/${params.clientId}` },
    robots: { index: false, follow: false },
  };
}

function TabLink({ clientId, current, value, label }: { clientId: string; current: string; value: string; label: string }) {
  const href = value === 'overview' ? `/admin/portal/${clientId}` : `/admin/portal/${clientId}?tab=${value}`;
  const active = current === value;
  return (
    <Link
      href={href}
      className={active ? 'btn-primary' : 'btn-ghost'}
      data-testid={`client-tab-${value}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

function FlowHistoryTimeline({ entries }: { entries: FlowActivityEntry[] }) {
  if (!entries.length) {
    return (
      <EmptyState
        title="Sin actividad registrada"
        description="Cuando el flujo n8n emita hitos o ejecuciones, aparecerán aquí ordenados en el tiempo."
      />
    );
  }
  return (
    <ol
      data-testid="flow-history-timeline"
      className="relative space-y-5 border-l border-kairikos-border pl-5"
    >
      {entries.map((entry) => {
        const dotClass =
          entry.status === 'success'
            ? 'bg-kairikos-success'
            : entry.status === 'failed'
              ? 'bg-kairikos-danger'
              : 'bg-kairikos-accent';
        const kindLabel =
          entry.kind === 'milestone'
            ? 'Hito'
            : entry.kind === 'n8n_execution'
              ? 'n8n'
              : 'Nota';
        return (
          <li
            key={entry.id}
            data-testid="flow-history-item"
            data-status={entry.status}
            data-kind={entry.kind}
            className="relative"
          >
            <span aria-hidden className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ${dotClass}`} />
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill-muted">{kindLabel}</span>
                <h3 className="text-sm font-semibold">{entry.label}</h3>
                {entry.status === 'failed' ? (
                  <span className="pill-danger" aria-label="Evento fallido">
                    Falló
                  </span>
                ) : entry.status === 'success' ? (
                  <span className="pill-success" aria-label="Evento correcto">
                    OK
                  </span>
                ) : null}
              </div>
              {entry.detail ? <p className="text-sm text-kairikos-muted">{entry.detail}</p> : null}
              <p className="text-xs text-kairikos-muted">{DATE_FORMAT.format(new Date(entry.occurredAt))}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function OnboardingOperatorControls({
  clientId,
  timeline,
  advance,
}: {
  clientId: string;
  timeline: OnboardingTimelineRow[];
  advance: (formData: FormData) => Promise<void>;
}) {
  const doneSteps = new Set(
    timeline.filter((row) => row.status === 'done').map((row) => row.step),
  );
  const pendingMilestones = ALLOWED_MILESTONES.filter((m) => {
    const dbMilestone = MILESTONE_TO_DB[m];
    return !doneSteps.has(dbMilestone);
  });
  const firstPending = pendingMilestones[0];

  return (
    <div
      className="mt-5 border-t border-kairikos-border pt-4"
      data-testid="onboarding-operator-controls"
    >
      <p className="mb-3 text-sm text-kairikos-muted">
        Como operador, puedes registrar los hitos del onboarding para que el
        cliente los vea activados en su portal. Esta acción escribe
        directamente en la línea de tiempo del cliente.
      </p>
      {timeline.length === 0 ? (
        firstPending ? (
          <form action={advance}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="milestone" value={firstPending} />
            <button
              type="submit"
              className="btn-primary"
              data-testid="onboarding-operator-start"
              data-milestone={firstPending}
            >
              Iniciar onboarding ({firstPending} · {MILESTONE_LABEL[firstPending]})
            </button>
          </form>
        ) : null
      ) : (
        <ul className="flex flex-col gap-2">
          {ALLOWED_MILESTONES.map((m) => {
            const dbMilestone = MILESTONE_TO_DB[m];
            const isDone = doneSteps.has(dbMilestone);
            return (
              <li
                key={m}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
                data-testid="onboarding-operator-row"
                data-milestone={m}
                data-done={isDone ? 'true' : 'false'}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">
                    {m} · {MILESTONE_LABEL[m]}
                  </span>
                  <span className="text-xs text-kairikos-muted">
                    {isDone
                      ? 'Marcado como completado.'
                      : 'Pendiente de registrar.'}
                  </span>
                </div>
                {isDone ? (
                  <span className="pill-success" data-testid="onboarding-operator-done-pill">
                    Completado
                  </span>
                ) : (
                  <form action={advance}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <input type="hidden" name="milestone" value={m} />
                    <button
                      type="submit"
                      className="btn-ghost"
                      data-testid="onboarding-operator-mark"
                      data-milestone={m}
                    >
                      Marcar como completado
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const MILESTONE_TO_DB: Record<string, OnboardingTimelineRow['step']> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};

export default async function AdminClientDetailPage({ params, searchParams }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/${encodeURIComponent(params.clientId)}`);
  }
  const tab = (searchParams.tab ?? 'overview').toLowerCase() === 'flow' ? 'flow' : 'overview';

  let companyName = 'Cliente';
  let email = '';
  let tier = 'starter';
  let state = 'in-progress';
  let notes: string | null = null;
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline: OnboardingTimelineRow[] = [];
  let flowHistory: FlowActivityEntry[] = [];
  // KAIA-13744 — when isDatabaseConfigured is true and the real client row
  // resolves, we surface a ChatbotStatusSummary built from the DB (not
  // MOCK_CHATBOT). The 7-day window drives the fallback / escalation rates
  // shown on the card; the page-level total `conversationCount` is also
  // carried so the helper can fall back to it when the 7-day window is
  // not supplied.
  let resolvedClientId: string | null = null;
  let resolvedGoLiveAt: string | null = null;
  let last7DaysCounts = { conversations: 0, fallback: 0, escalation: 0 };
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
          state: true,
          notes: true,
          goLiveAt: true,
        },
      });
      if (client) {
        companyName = client.companyName ?? client.name;
        email = client.email;
        tier = client.tier;
        state = client.state;
        notes = client.notes;
        goLiveAt = client.goLiveAt?.toISOString() ?? null;
        resolvedClientId = client.id;
        resolvedGoLiveAt = goLiveAt;
        // KAIA-13744 — the ChatbotStatusCard needs a real 7-day conversation
        // window. The total `count` is used by the activity loop, and a
        // separate `groupBy` over the last 7 days drives the fallback and
        // escalation rates on the card.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        // KAIA-14388 — `chatbotActivity.findMany` is the read that immediately
        // follows `advanceOnboardingMilestone`. We route it through the
        // direct-connection client (`@/lib/prisma-direct`, port 5432) so it
        // shares the same physical connection as the action's write. Falls
        // back to the pooler-bound `prisma` when no direct URL is configured
        // (unit tests with DATABASE_URL unset).
        const activityClient = isDatabaseDirectConfigured ? prismaDirect : prisma;
        const [count, recentGroups, activities] = await Promise.all([
          prisma.chatbotConversation.count({ where: { clientId: client.id } }),
          prisma.chatbotConversation.groupBy({
            by: ['outcome'],
            where: {
              clientId: client.id,
              startedAt: { gte: sevenDaysAgo },
            },
            _count: { _all: true },
          }),
          activityClient.chatbotActivity.findMany({
            where: { clientId: client.id },
            orderBy: { completedAt: 'asc' },
          }),
        ]);
        conversationCount = count;
        let sevenDayConversations = 0;
        let sevenDayFallback = 0;
        let sevenDayEscalation = 0;
        for (const group of recentGroups) {
          const n = group._count._all;
          sevenDayConversations += n;
          if (group.outcome === 'fallback') sevenDayFallback += n;
          else if (group.outcome === 'escalated') sevenDayEscalation += n;
        }
        last7DaysCounts = {
          conversations: sevenDayConversations,
          fallback: sevenDayFallback,
          escalation: sevenDayEscalation,
        };
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
          flowHistory = activities
            .filter((a) => a.completedAt)
            .map((a) => ({
              id: `fa_db_${a.id}`,
              kind: 'milestone' as const,
              label: `${a.milestone} · ${MILESTONE_LABEL[a.milestone] ?? ''}`.trim(),
              occurredAt: a.completedAt!.toISOString(),
              status: 'success' as const,
              detail: a.notes ?? null,
            }));
        }
      } else {
        notFound();
      }
    } catch {
      // fall back to mock lookup
    }
  }
  // KAIA-13753 hardening (mirrors [clientId]/wizard) — gate every dev-mock
  // fallback on !isDatabaseConfigured. A `companyName === 'Cliente'` /
  // `flowHistory.length === 0` post-DB gate would mask legitimate real
  // states (a tenant with NULL companyName; a fresh tenant with no
  // Activity rows; a tenant with no n8n executions) behind the
  // Acme Corp / Globex Inc fixture. Only `!isDatabaseConfigured`
  // (local `next dev` without DATABASE_URL) surfaces mocks.
  if (!isDatabaseConfigured) {
    const mockMatch = [MOCK_CLIENT, MOCK_SECONDARY_CLIENT].find(
      (m) => m.id === params.clientId,
    );
    if (mockMatch) {
      companyName = mockMatch.companyName;
      email = mockMatch.primaryContactEmail;
      tier = mockMatch.tier;
      state = mockMatch.onboardingStatus;
      goLiveAt = mockMatch.goLiveDate;
    } else {
      notFound();
    }
    flowHistory = MOCK_FLOW_ACTIVITY[params.clientId] ?? [];
    timeline = MOCK_TIMELINE;
  }

  // KAIA-13753 hardening — n8n executions: try Prisma first, fall back to
  // dev-mock fixtures only when !isDatabaseConfigured. Mirrors the
  // /admin/portal/flows panel pattern from KAIA-13756.
  let n8nExecutions: N8nExecutionSummary[] = [];
  if (!isDatabaseConfigured) {
    n8nExecutions = MOCK_N8N_EXECUTIONS.filter(
      (e) => e.clientId === params.clientId,
    );
  } else {
    try {
      const dbRows = await prisma.n8nExecution.findMany({
        where: { clientId: params.clientId },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          clientId: true,
          clientName: true,
          workflow: true,
          milestone: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          errorCode: true,
          errorMessage: true,
        },
      });
      n8nExecutions = dbRows.map((e) => ({
        id: e.id,
        clientId: e.clientId ?? '',
        clientName: e.clientName ?? '—',
        workflow: e.workflow,
        milestone: e.milestone,
        status:
          e.status === 'failed' || e.status === 'success' || e.status === 'running'
            ? e.status
            : 'running',
        startedAt: e.startedAt.toISOString(),
        finishedAt: e.finishedAt?.toISOString() ?? null,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[admin/portal/[clientId]] failed to load n8n executions:',
        err,
      );
      n8nExecutions = [];
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
            Modo lectura — para editar, baja a la sección Editar
          </span>
        }
      />

      <nav
        aria-label="Pestañas del cliente"
        className="card flex flex-wrap items-center gap-2 p-3"
        data-testid="client-tab-bar"
      >
        <TabLink clientId={params.clientId} current={tab} value="overview" label="Resumen" />
        <TabLink clientId={params.clientId} current={tab} value="flow" label="Flujo" />
      </nav>

      <OperatorEditor
        clientId={params.clientId}
        initial={{
          companyName,
          email,
          tier,
          state,
          goLiveAt,
          notes,
        }}
      />

      {tab === 'overview' ? (
        <>
          <section className="card" aria-label="Estado del chatbot del cliente">
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Estado del chatbot</h2>
              <span className={status === 'live' ? 'pill-success' : 'pill-warning'}>
                {status === 'live' ? 'En producción' : 'En curso'}
              </span>
            </header>
            <ChatbotStatusCard
              summary={buildAdminClientChatbotStatus({
                isDatabaseConfigured,
                client:
                  resolvedClientId !== null
                    ? { id: resolvedClientId, goLiveAt: resolvedGoLiveAt }
                    : null,
                last7DaysCounts,
                conversationCount,
              })}
            />
          </section>

          <section className="card" aria-label="Onboarding del cliente">
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Onboarding</h2>
              {session.isOperator && isDatabaseConfigured ? (
                <span
                  data-testid="onboarding-operator-badge"
                  className="pill-muted"
                >
                  Controles de operador activos
                </span>
              ) : null}
            </header>
            <OnboardingTimeline rows={timeline} />
            {session.isOperator && isDatabaseConfigured ? (
              <OnboardingOperatorControls
                clientId={params.clientId}
                timeline={timeline}
                advance={advanceOnboardingMilestone}
              />
            ) : null}
          </section>

          <p className="text-xs text-kairikos-muted">
            Esta vista replica el portal del cliente sin posibilidad de modificar datos.
            Para soporte, accede a la{' '}
            <Link href="/admin/portal" className="underline">lista de clientes</Link>.
          </p>
        </>
      ) : (
        <>
          <section
            className="card"
            aria-label="Historial de actividad del flujo"
            data-testid="flow-history-section"
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Historial del flujo</h2>
              <Link
                href={`/admin/portal/flows${n8nExecutions.some((e) => e.status === 'failed') ? '?filter=failed' : ''}`}
                className="text-sm text-kairikos-accent2 underline"
              >
                Ver dashboard de flujos
              </Link>
            </header>
            <FlowHistoryTimeline entries={flowHistory} />
          </section>

          <section
            className="card"
            aria-label="Ejecuciones de n8n para este cliente"
            data-testid="flow-n8n-section"
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Ejecuciones de n8n</h2>
              <span className="text-sm text-kairikos-muted">
                {n8nExecutions.length} ejecución{n8nExecutions.length === 1 ? '' : 'es'} registrada{n8nExecutions.length === 1 ? '' : 's'}
              </span>
            </header>
            {n8nExecutions.length === 0 ? (
              <EmptyState
                title="Sin ejecuciones de n8n"
                description="Cuando el flujo n8n se ejecute para este cliente, los resultados aparecerán aquí."
              />
            ) : (
              <ul className="space-y-3 text-sm">
                {n8nExecutions.map((exec) => (
                  <li
                    key={exec.id}
                    data-testid="flow-n8n-execution"
                    data-status={exec.status}
                    className="flex flex-col gap-1 border-b border-kairikos-border pb-3 last:border-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{exec.workflow}</span>
                      <span
                        className={
                          exec.status === 'success'
                            ? 'pill-success'
                            : exec.status === 'failed'
                              ? 'pill-danger'
                              : 'pill-warning'
                        }
                      >
                        {exec.status === 'success' ? 'OK' : exec.status === 'failed' ? 'Falló' : 'En curso'}
                      </span>
                    </div>
                    <div className="text-xs text-kairikos-muted">
                      {exec.milestone ? `${exec.milestone} · ` : ''}
                      Inicio: {DATE_FORMAT.format(new Date(exec.startedAt))}
                      {exec.finishedAt
                        ? ` · Fin: ${DATE_FORMAT.format(new Date(exec.finishedAt))}`
                        : ''}
                    </div>
                    {exec.errorMessage ? (
                      <p className="text-xs text-kairikos-danger" data-testid="flow-n8n-error">
                        {exec.errorCode ? `${exec.errorCode}: ` : ''}
                        {exec.errorMessage}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-kairikos-muted">
            Esta vista es de sólo lectura. La pestaña{' '}
            <Link href={`/admin/portal/${params.clientId}`} className="underline">Resumen</Link>{' '}
            muestra el estado del chatbot.
          </p>
        </>
      )}
    </div>
  );
}
