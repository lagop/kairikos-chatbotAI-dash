import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { EmptyState } from '@/components/portal/EmptyState';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from '@/lib/portal-data';
import { MOCK_FLOW_ACTIVITY, MOCK_N8N_EXECUTIONS, type FlowActivityEntry } from '@/lib/flow-health';

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

export default async function AdminClientDetailPage({ params, searchParams }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/${encodeURIComponent(params.clientId)}`);
  }
  const tab = (searchParams.tab ?? 'overview').toLowerCase() === 'flow' ? 'flow' : 'overview';

  let companyName = 'Cliente';
  let email = '';
  let tier = 'starter';
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline = MOCK_TIMELINE;
  let flowHistory: FlowActivityEntry[] = [];
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

  if (flowHistory.length === 0) {
    flowHistory = MOCK_FLOW_ACTIVITY[params.clientId] ?? [];
  }
  const n8nExecutions = MOCK_N8N_EXECUTIONS.filter((e) => e.clientId === params.clientId);

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

      <nav
        aria-label="Pestañas del cliente"
        className="card flex flex-wrap items-center gap-2 p-3"
        data-testid="client-tab-bar"
      >
        <TabLink clientId={params.clientId} current={tab} value="overview" label="Resumen" />
        <TabLink clientId={params.clientId} current={tab} value="flow" label="Flujo" />
      </nav>

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
