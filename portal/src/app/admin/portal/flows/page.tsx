import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { TIER_LABEL } from '@/lib/billing-tier';
import {
  MOCK_N8N_EXECUTIONS,
  MOCK_FLOW_HEALTH_ROWS,
  getFlowHealthRows,
  STUCK_DAYS as STUCK_THRESHOLD_DAYS,
  type FlowHealthRow,
  type N8nExecutionSummary,
} from '@/lib/flow-health';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Salud de los flujos · Operador',
  description:
    'Vista de operador: clientes atascados, hitos vencidos y ejecuciones recientes de n8n (sólo lectura).',
  alternates: { canonical: '/admin/portal/flows' },
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: { filter?: string };
}

const N8N_STATUS_PILL: Record<'success' | 'failed' | 'unknown', string> = {
  success: 'pill-success',
  failed: 'pill-danger',
  unknown: 'pill-muted',
};

const N8N_STATUS_LABEL: Record<'success' | 'failed' | 'unknown', string> = {
  success: 'OK',
  failed: 'Falló',
  unknown: 'Sin datos',
};

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleDateString('es-ES');
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export default async function AdminFlowsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/flows');
  }

  const filter = (searchParams.filter ?? 'all').toLowerCase();

  // WP-10 — getFlowHealthRows() is the single per-client "last activity +
  // last n8n execution" read, shared with GET /api/admin/portal/flows so
  // there's exactly one implementation instead of two drifting apart.
  //
  // KAIA-13758 — mirror the `listAdminClients` (KAIA-13715) hardening: try
  // Prisma unconditionally, surface a real empty state when Prisma returns
  // zero rows, and only fall back to dev-mock fixtures when Prisma itself
  // throws AND the DB is not configured (i.e. local `next dev` without
  // DATABASE_URL). A `rows.length === 0` post-DB gate would mask legitimate
  // empty tenant lists and a transient Prisma outage behind the same
  // MOCK_FLOW_HEALTH_ROWS fixture the audit flagged in KAIA-13753.
  let rows: FlowHealthRow[] = [];
  let n8nFailureCount = 0;
  try {
    rows = await getFlowHealthRows(prisma);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin/portal/flows] Prisma read failed:', err);
    if (!isDatabaseConfigured) {
      rows = MOCK_FLOW_HEALTH_ROWS;
    }
  }
  // KAIA-13758 — when Prisma returned successfully with zero rows we
  // intentionally render an empty state below, NOT the MOCK_* fallback. The
  // previous `rows.length === 0` gate here was the bug the audit flagged.

  const stuckCount = rows.filter((r) => r.stuck).length;
  n8nFailureCount = rows.filter((r) => r.lastN8nStatus === 'failed').length;

  // KAIA-13756 — surface the "Ejecuciones fallidas recientes" panel from
  // real n8n execution capture when the DB is configured. The previous
  // implementation read the n8n-execution fixture unconditionally, which
  // is the same regression class as KAIA-13680 / KAIA-13744 (production
  // shows dev-mock `Acme Corp` / `Globex Inc` / `Hooli Iberia` /
  // `Initech S.L.` rows). The dev-mock branch below keeps `next dev`
  // working when DATABASE_URL is unset.
  let failedExecutions: N8nExecutionSummary[] = [];
  if (!isDatabaseConfigured) {
    // Dev-mock fallback: render MOCK_N8N_EXECUTIONS so `next dev`
    // without DATABASE_URL stays exercisable. Guarded by
    // `!isDatabaseConfigured` — the structural test (KAIA-13745) marks
    // this branch as gated.
    failedExecutions = MOCK_N8N_EXECUTIONS.filter((e) => e.status === 'failed').slice(0, 5);
  } else if (isDatabaseConfigured) {
    try {
      const dbRows = await prisma.n8nExecution.findMany({
        where: { status: 'failed' },
        orderBy: { startedAt: 'desc' },
        take: 5,
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
      failedExecutions = dbRows.map((e) => ({
        id: e.id,
        clientId: e.clientId ?? '',
        clientName: e.clientName ?? '—',
        workflow: e.workflow,
        milestone: e.milestone,
        status: 'failed',
        startedAt: e.startedAt.toISOString(),
        finishedAt: e.finishedAt?.toISOString() ?? null,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
      }));
    } catch (err) {
      // Surface the error in server logs but keep the panel empty — a
      // throw would blank the rest of the operator dashboard. The
      // operator can still navigate to the per-client flow view for
      // diagnostics.
      console.error('[flows] failed to load n8n failures', err);
      failedExecutions = [];
    }
  }

  const visibleRows = rows.filter((r) => {
    if (filter === 'stuck') return r.stuck;
    if (filter === 'failed') return r.lastN8nStatus === 'failed';
    return true;
  });

  const filterButton = (key: string, label: string) => {
    const active = filter === key;
    const href = key === 'all' ? '/admin/portal/flows' : `/admin/portal/flows?filter=${key}`;
    return (
      <Link
        href={href}
        className={active ? 'btn-primary' : 'btn-ghost'}
        data-testid={`flow-filter-${key}`}
        aria-pressed={active}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/clients" className="hover:text-kairikos-text">
          ← Volver al listado de clientes
        </Link>
      </div>
      <PageHeading
        eyebrow="Operador · salud de los flujos"
        title="Flujos de onboarding"
        description={`${rows.length} cliente${rows.length === 1 ? '' : 's'} monitorizado${rows.length === 1 ? '' : 's'} · ${stuckCount} atascado${stuckCount === 1 ? '' : 's'} · ${n8nFailureCount} con ejecución de n8n fallida reciente`}
        actions={
          <form action="/api/portal/operator" method="post">
            <input type="hidden" name="mode" value="disable" />
            <input type="hidden" name="return_to" value="/admin/portal/flows" />
            <button type="submit" className="btn-ghost">
              Salir del modo operador
            </button>
          </form>
        }
      />

      <nav
        aria-label="Filtros de salud del flujo"
        className="card flex flex-wrap items-center gap-2 p-3"
        data-testid="flow-filter-bar"
      >
        {filterButton('all', `Todos (${rows.length})`)}
        {filterButton('stuck', `Atascados (${stuckCount})`)}
        {filterButton('failed', `Con fallo de n8n (${n8nFailureCount})`)}
      </nav>

      {visibleRows.length === 0 ? (
        <EmptyState
          title={
            filter === 'stuck'
              ? 'Sin clientes atascados'
              : filter === 'failed'
                ? 'Sin ejecuciones fallidas recientes'
                : 'Sin clientes monitorizados'
          }
          description={
            filter === 'stuck'
              ? `Ningún cliente lleva más de ${STUCK_THRESHOLD_DAYS} días sin completar un hito.`
              : filter === 'failed'
                ? 'Las ejecuciones recientes de n8n se han completado correctamente.'
                : 'Cuando se den de alta clientes en el portal aparecerán aquí.'
          }
        />
      ) : (
        <section
          className="card overflow-x-auto"
          aria-label="Salud de los flujos por cliente"
          data-testid="flow-health-table"
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-kairikos-muted">
                <th scope="col" className="pb-3 pr-4">
                  Cliente
                </th>
                <th scope="col" className="pb-3 pr-4">
                  Plan
                </th>
                <th scope="col" className="pb-3 pr-4">
                  Hito actual
                </th>
                <th scope="col" className="pb-3 pr-4">
                  Días en hito
                </th>
                <th scope="col" className="pb-3 pr-4">
                  Última actividad
                </th>
                <th scope="col" className="pb-3 pr-4">
                  Atascado
                </th>
                <th scope="col" className="pb-3">
                  Última ejecución n8n
                </th>
                <th scope="col" className="pb-3 pl-4">
                  Detalle
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kairikos-border">
              {visibleRows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="flow-health-row"
                  data-client-id={row.id}
                  data-stuck={row.stuck ? 'true' : 'false'}
                  data-n8n-status={row.lastN8nStatus}
                >
                  <td className="py-3 pr-4 font-medium">{row.companyName}</td>
                  <td className="py-3 pr-4">{TIER_LABEL[row.tier] ?? row.tier}</td>
                  <td className="py-3 pr-4">
                    {row.currentMilestone ? (
                      <span className="pill-muted">{row.currentMilestone}</span>
                    ) : (
                      <span className="text-kairikos-muted">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {row.daysInMilestone !== null ? `${row.daysInMilestone} d` : '—'}
                  </td>
                  <td className="py-3 pr-4 text-kairikos-muted">
                    {formatRelative(row.lastActivityAt)}
                  </td>
                  <td className="py-3 pr-4">
                    {row.stuck ? (
                      <span className="pill-danger" aria-label="Cliente atascado">
                        Sí
                      </span>
                    ) : (
                      <span className="pill-muted" aria-label="Cliente no atascado">
                        No
                      </span>
                    )}
                  </td>
                  <td className="py-3">
                    <span
                      className={N8N_STATUS_PILL[row.lastN8nStatus]}
                      data-testid="flow-n8n-status"
                    >
                      {N8N_STATUS_LABEL[row.lastN8nStatus]}
                    </span>
                    <span className="ml-2 text-xs text-kairikos-muted">
                      {formatRelative(row.lastN8nAt)}
                    </span>
                  </td>
                  <td className="py-3 pl-4">
                    <Link
                      href={`/admin/portal/${row.id}?tab=flow`}
                      className="text-kairikos-accent2 underline"
                      data-testid="flow-row-open"
                    >
                      Ver flujo →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {failedExecutions.length > 0 ? (
        <section
          className="card"
          aria-label="Ejecuciones fallidas recientes de n8n"
          data-testid="flow-n8n-failures"
        >
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Ejecuciones fallidas recientes</h2>
            <span className="pill-danger">{failedExecutions.length}</span>
          </header>
          <ul className="space-y-2 text-sm">
            {failedExecutions.map((exec) => (
              <li
                key={exec.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-kairikos-border pb-2 last:border-0"
                data-testid="flow-n8n-failure"
              >
                <div>
                  <span className="font-medium">{exec.workflow}</span>
                  <span className="ml-2 text-kairikos-muted">{exec.clientName}</span>
                </div>
                <div className="text-xs text-kairikos-muted">
                  {formatRelative(exec.finishedAt)} · {exec.errorCode ?? 'sin código'}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}


