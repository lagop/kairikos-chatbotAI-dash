import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from '@/lib/portal-data';
import { WIZARD_STEP_NUMBERS, type WizardStepNumber } from '@/lib/wizard-catalog';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Embudo de cohortes · Operador',
  description:
    'Tabla por cliente con el estado de cada paso del wizard y la fecha de la última edición. Permite identificar clientes atascados o abandonados.',
  alternates: { canonical: '/admin/portal/wizard-funnel' },
  robots: { index: false, follow: false },
};

const TIER_LABEL: Record<string, string> = {
  starter: 'Web Starter',
  pro: 'Web Pro',
  premium: 'Web Premium',
};

const STATUS_PILL: Record<string, string> = {
  draft: 'pill-muted',
  submitted: 'pill-warning',
  approved: 'pill-success',
  needs_revision: 'pill-danger',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  submitted: 'En revisión',
  approved: 'Aprobado',
  needs_revision: 'Requiere cambios',
};

const STUCK_DAYS = 3;

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return DATE_FORMAT.format(new Date(iso));
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

interface ClientFunnelRow {
  clientId: string;
  companyName: string;
  email: string;
  tier: string;
  goLiveAt: string | null;
  lastUpdatedAt: string | null;
  perStep: Array<{ stepKey: string; status: string | null; updatedAt: string | null; activeForBot: boolean }>;
  approvedCount: number;
  submittedCount: number;
  needsRevisionCount: number;
  totalSteps: number;
  stuck: boolean;
}

async function loadRowsFromDb(): Promise<ClientFunnelRow[]> {
  const clients = await prisma.chatbotClient.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      companyName: true,
      name: true,
      email: true,
      tier: true,
      goLiveAt: true,
    },
  });

  const rows: ClientFunnelRow[] = [];
  for (const c of clients) {
    const stepRows = await prisma.chatbotConfigStep.findMany({
      where: { clientId: c.id },
      orderBy: [{ stepKey: 'asc' }, { version: 'desc' }],
      select: {
        stepKey: true,
        version: true,
        status: true,
        updatedAt: true,
        activeForBot: true,
      },
    });

    const latestByStep = new Map<
      string,
      { stepKey: string; status: string; updatedAt: string; activeForBot: boolean }
    >();
    for (const r of stepRows) {
      if (latestByStep.has(r.stepKey)) continue;
      latestByStep.set(r.stepKey, {
        stepKey: r.stepKey,
        status: r.status,
        updatedAt: r.updatedAt.toISOString(),
        activeForBot: r.activeForBot,
      });
    }

    let lastUpdated: string | null = null;
    let approved = 0;
    let submitted = 0;
    let needsRev = 0;
    const perStep = WIZARD_STEP_NUMBERS.map((n) => {
      const key = String(n as WizardStepNumber);
      const latest = latestByStep.get(key);
      if (latest) {
        if (!lastUpdated || latest.updatedAt > lastUpdated) lastUpdated = latest.updatedAt;
        if (latest.status === 'approved') approved += 1;
        else if (latest.status === 'submitted') submitted += 1;
        else if (latest.status === 'needs_revision') needsRev += 1;
        return {
          stepKey: key,
          status: latest.status,
          updatedAt: latest.updatedAt,
          activeForBot: latest.activeForBot,
        };
      }
      return { stepKey: key, status: null, updatedAt: null, activeForBot: false };
    });

    const stuck =
      !c.goLiveAt &&
      (!lastUpdated || Date.now() - new Date(lastUpdated).getTime() > STUCK_DAYS * 24 * 60 * 60 * 1000);

    rows.push({
      clientId: c.id,
      companyName: c.companyName ?? c.name ?? 'Cliente',
      email: c.email,
      tier: c.tier,
      goLiveAt: c.goLiveAt?.toISOString() ?? null,
      lastUpdatedAt: lastUpdated,
      perStep,
      approvedCount: approved,
      submittedCount: submitted,
      needsRevisionCount: needsRev,
      totalSteps: WIZARD_STEP_NUMBERS.length,
      stuck,
    });
  }
  return rows;
}

function loadMockRows(): ClientFunnelRow[] {
  const now = Date.now();
  const mk = (
    c: typeof MOCK_CLIENT | typeof MOCK_SECONDARY_CLIENT,
    lastDays: number,
    approved: number[],
  ): ClientFunnelRow => {
    const lastUpdated = new Date(now - lastDays * 24 * 60 * 60 * 1000).toISOString();
    const perStep = WIZARD_STEP_NUMBERS.map((n) => {
      const key = String(n as WizardStepNumber);
      if (approved.includes(n)) {
        return { stepKey: key, status: 'approved', updatedAt: lastUpdated, activeForBot: true };
      }
      return { stepKey: key, status: null, updatedAt: null, activeForBot: false };
    });
    return {
      clientId: c.id,
      companyName: c.companyName,
      email: c.primaryContactEmail,
      tier: c.tier,
      goLiveAt: c.goLiveDate ?? null,
      lastUpdatedAt: approved.length > 0 ? lastUpdated : null,
      perStep,
      approvedCount: approved.length,
      submittedCount: 0,
      needsRevisionCount: 0,
      totalSteps: WIZARD_STEP_NUMBERS.length,
      stuck: approved.length === 0 && lastDays > STUCK_DAYS,
    };
  };
  return [
    mk(MOCK_CLIENT, 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    mk(MOCK_SECONDARY_CLIENT, 5, [1, 2, 3]),
  ];
}

export default async function AdminWizardFunnelPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/sin-acceso');
  }

  // KAIA-13758 — mirror the `listAdminClients` (KAIA-13715) hardening: try
  // Prisma unconditionally, surface a real empty state when Prisma returns
  // zero rows, and only fall back to dev-mock fixtures when Prisma itself
  // throws AND the DB is not configured (i.e. local `next dev` without
  // DATABASE_URL). A `rows.length === 0` post-DB gate would mask legitimate
  // empty tenant lists and a transient Prisma outage behind the same
  // Acme Corp / Globex Inc fixture.
  let rows: ClientFunnelRow[] = [];
  try {
    rows = await loadRowsFromDb();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin/portal/wizard-funnel] Prisma read failed:', err);
    if (!isDatabaseConfigured) {
      rows = loadMockRows();
    }
  }
  // KAIA-13758 — when Prisma returned successfully with zero rows we
  // intentionally render the 'Sin clientes' empty state below, NOT the
  // MOCK_* fallback. The previous `rows.length === 0` gate here was the bug
  // the audit flagged.

  const stuckCount = rows.filter((r) => r.stuck).length;
  const liveCount = rows.filter((r) => r.goLiveAt !== null).length;
  const stepKeys = WIZARD_STEP_NUMBERS.map((n) => String(n as WizardStepNumber));

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal" className="hover:text-kairikos-text">
          ← Volver al listado de clientes
        </Link>
      </div>

      <PageHeading
        eyebrow="Operador · embudo de cohortes"
        title="Embudo de configuración por cliente"
        description={`${rows.length} cliente${rows.length === 1 ? '' : 's'} · ${stuckCount} atascado${stuckCount === 1 ? '' : 's'} (más de ${STUCK_DAYS} días sin editar) · ${liveCount} en producción`}
        actions={
          <form action="/api/portal/operator" method="post">
            <input type="hidden" name="mode" value="disable" />
            <input type="hidden" name="return_to" value="/admin/portal/wizard-funnel" />
            <button type="submit" className="btn-ghost">
              Salir del modo operador
            </button>
          </form>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Sin clientes"
          description="Cuando se den de alta clientes en el portal aparecerán aquí con el estado de su wizard."
        />
      ) : (
        <section
          className="card overflow-x-auto"
          aria-label="Embudo por cliente"
          data-testid="wizard-funnel-cohort-table"
        >
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-kairikos-muted">
                <th scope="col" className="pb-3 pr-4">Cliente</th>
                <th scope="col" className="pb-3 pr-4">Plan</th>
                <th scope="col" className="pb-3 pr-4">Progreso</th>
                {stepKeys.map((k) => (
                  <th key={k} scope="col" className="px-1 pb-3 text-center" title={`Paso ${k}`}>
                    {k}
                  </th>
                ))}
                <th scope="col" className="pb-3 pr-4 pl-3">Última edición</th>
                <th scope="col" className="pb-3 pr-4">Atascado</th>
                <th scope="col" className="pb-3">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kairikos-border">
              {rows.map((row) => (
                <tr
                  key={row.clientId}
                  data-testid="wizard-funnel-row"
                  data-client-id={row.clientId}
                  data-stuck={row.stuck ? 'true' : 'false'}
                >
                  <td className="py-3 pr-4">
                    <div className="flex flex-col">
                      <span className="font-medium">{row.companyName}</span>
                      <span className="text-xs text-kairikos-muted">{row.email}</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4">{TIER_LABEL[row.tier] ?? row.tier}</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm font-semibold tabular-nums"
                        data-testid="wizard-funnel-progress"
                      >
                        {row.approvedCount}/{row.totalSteps}
                      </span>
                      {row.submittedCount > 0 ? (
                        <span className="pill-warning text-[10px]" title="Pasos en revisión">
                          {row.submittedCount} en revisión
                        </span>
                      ) : null}
                      {row.needsRevisionCount > 0 ? (
                        <span className="pill-danger text-[10px]" title="Pasos con cambios solicitados">
                          {row.needsRevisionCount} con cambios
                        </span>
                      ) : null}
                      {row.goLiveAt ? (
                        <span className="pill-success text-[10px]">En producción</span>
                      ) : null}
                    </div>
                  </td>
                  {row.perStep.map((s) => {
                    const pill =
                      s.status === 'approved'
                        ? 'bg-kairikos-success/80'
                        : s.status === 'submitted'
                          ? 'bg-kairikos-warning'
                          : s.status === 'needs_revision'
                            ? 'bg-kairikos-danger'
                            : s.status === 'draft'
                              ? 'bg-kairikos-muted/40'
                              : 'bg-kairikos-border';
                    const titleSuffix = s.status
                      ? ` · ${STATUS_LABEL[s.status] ?? s.status}`
                      : ' · sin datos';
                    return (
                      <td
                        key={s.stepKey}
                        className="px-1 py-3 text-center"
                        title={`Paso ${s.stepKey}${titleSuffix}`}
                        data-testid={`wizard-funnel-cell-${row.clientId}-${s.stepKey}`}
                        data-step-status={s.status ?? 'none'}
                      >
                        <span
                          aria-hidden
                          className={`mx-auto block h-3 w-3 rounded-full ${pill}`}
                        />
                      </td>
                    );
                  })}
                  <td className="py-3 pr-4 pl-3 text-kairikos-muted">
                    {formatRelative(row.lastUpdatedAt)}
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
                    <Link
                      href={`/admin/portal/${row.clientId}/wizard`}
                      className="text-kairikos-accent2 underline"
                      data-testid="wizard-funnel-row-open"
                    >
                      Ver wizard →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="text-xs text-kairikos-muted">
        Esta vista muestra el estado de cada paso del wizard por cliente, para identificar
        rápidamente quién está atascado (más de {STUCK_DAYS} días sin editar) o quién ya está
        en producción. Pulsa <em>Ver wizard</em> para abrir el detalle por cliente.
      </p>
    </div>
  );
}
