import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { WizardBlockProgress, type WizardBlockProgressStep } from '@/components/portal/WizardBlockProgress';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from '@/lib/portal-data';
import { resolveClientTier, readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import { buildSavedStateMap, listStepsForOperator } from '@/lib/wizard-visibility';
import { getStepDefinition, WIZARD_STEP_NUMBERS, CHATBOT_PRODUCT_CODE, type WizardStepNumber } from '@/lib/wizard-catalog';
import { TIER_LABEL } from '@/lib/billing-tier';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { clientId: string };
}

const BLOCK_LABEL: Record<string, string> = {
  identidad: 'Identidad',
  comportamiento: 'Comportamiento',
  activacion: 'Activación',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  submitted: 'En revisión',
  approved: 'Aprobado',
  needs_revision: 'Requiere cambios',
};

const STATUS_PILL: Record<string, string> = {
  draft: 'pill-muted',
  submitted: 'pill-warning',
  approved: 'pill-success',
  needs_revision: 'pill-danger',
};

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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: `Wizard · Operador`,
    description:
      'Resumen del wizard de configuración para un cliente concreto (sólo operador).',
    alternates: { canonical: `/admin/portal/${params.clientId}/wizard` },
    robots: { index: false, follow: false },
  };
}

export default async function AdminClientWizardPage({ params }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/sin-acceso');
  }

  let companyName = 'Cliente';
  let email = '';
  let tier = 'starter';
  let goLiveAt: Date | null = null;
  let lastUpdated: string | null = null;

  let progressSteps: WizardBlockProgressStep[] = WIZARD_STEP_NUMBERS.map((n) => {
    const def = getStepDefinition(n as WizardStepNumber);
    return {
      number: def.number,
      key: def.key,
      label: def.label,
      visible: !def.v11Deferred,
      autoConfigured: true,
      v11Deferred: def.v11Deferred,
    };
  });
  let stepSummaries: Array<{
    key: string;
    number: number;
    label: string;
    block: string;
    v11Deferred: boolean;
    status: string | null;
    submittedAt: string | null;
    approvedAt: string | null;
    activeForBot: boolean;
    lastUpdatedAt: string | null;
  }> = [];
  let latestByStep: Map<string, { status: string; submittedAt: string | null; approvedAt: string | null; activeForBot: boolean; createdAt: string; updatedAt: string }> = new Map();

  let foundInDb = false;
  // KAIA-13758 — mirror the `listAdminClients` (KAIA-13715) hardening: try
  // Prisma unconditionally, surface a real empty state when Prisma returns
  // zero rows, and only fall back to dev-mock fixtures when Prisma itself
  // throws AND the DB is not configured (i.e. local `next dev` without
  // DATABASE_URL). A `stepSummaries.length === 0` post-DB gate would mask
  // a legitimate client with no saved wizard steps AND a transient Prisma
  // outage behind the same MOCK_CLIENT fixture.
  try {
    const client = await resolveClientTier(prisma, params.clientId);
    if (client) {
      const fullClient = await prisma.chatbotClient.findUnique({
        where: { id: client.clientId },
        select: { companyName: true, name: true, email: true, tier: true, goLiveAt: true },
      });
      if (fullClient) {
        foundInDb = true;
        companyName = fullClient.companyName ?? fullClient.name ?? 'Cliente';
        email = fullClient.email ?? client.email;
        tier = fullClient.tier ?? 'starter';
        goLiveAt = fullClient.goLiveAt;
      }
    } else {
      notFound();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin/portal/[clientId]/wizard] client Prisma read failed:', err);
    if (!isDatabaseConfigured) {
      // dev-mock fallback below — populate from the matching mock fixture
      const mockMatch =
        [MOCK_CLIENT, MOCK_SECONDARY_CLIENT].find((m) => m.id === params.clientId) ??
        MOCK_CLIENT;
      companyName = mockMatch.companyName;
      email = mockMatch.primaryContactEmail;
      tier = mockMatch.tier;
      goLiveAt = mockMatch.goLiveDate ? new Date(mockMatch.goLiveDate) : null;
    }
  }

  if (foundInDb) {
    try {
      const savedRows = await readLatestStepsForClient(prisma, params.clientId, CHATBOT_PRODUCT_CODE);
      const savedMap = buildSavedStateMap(
        savedRows.map((r) => ({
          stepKey: r.stepKey,
          latest: r.latest
            ? {
                status: r.latest.status,
                submittedAt: r.latest.submittedAt?.toISOString() ?? null,
                approvedAt: r.latest.approvedAt?.toISOString() ?? null,
                activeForBot: r.latest.activeForBot,
              }
            : null,
        })),
      );

      const operator = listStepsForOperator(
        params.clientId,
        (tier as 'starter' | 'pro' | 'premium' | null) ?? null,
        savedMap,
      );
      progressSteps = operator.steps.map((s) => ({
        number: s.number,
        key: s.key,
        label: s.label,
        visible: s.visible,
        autoConfigured: s.autoConfigured,
        v11Deferred: s.v11Deferred,
      }));

      const stepRows = await prisma.chatbotConfigStep.findMany({
        where: { clientId: params.clientId },
        orderBy: [{ stepKey: 'asc' }, { version: 'desc' }],
        select: {
          stepKey: true,
          version: true,
          status: true,
          submittedAt: true,
          approvedAt: true,
          activeForBot: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      for (const row of stepRows) {
        if (latestByStep.has(row.stepKey)) continue;
        latestByStep.set(row.stepKey, {
          status: row.status,
          submittedAt: row.submittedAt?.toISOString() ?? null,
          approvedAt: row.approvedAt?.toISOString() ?? null,
          activeForBot: row.activeForBot,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        });
      }

      stepSummaries = operator.steps.map((s) => {
        const latest = latestByStep.get(s.key);
        if (latest) {
          const candidate = latest.updatedAt;
          if (!lastUpdated || (candidate && candidate > lastUpdated)) lastUpdated = candidate;
        }
        return {
          key: s.key,
          number: s.number,
          label: s.label,
          block: s.block,
          v11Deferred: s.v11Deferred,
          status: latest?.status ?? null,
          submittedAt: latest?.submittedAt ?? null,
          approvedAt: latest?.approvedAt ?? null,
          activeForBot: latest?.activeForBot ?? false,
          lastUpdatedAt: latest?.updatedAt ?? null,
        };
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[admin/portal/[clientId]/wizard] steps Prisma read failed:', err);
      // KAIA-13758 — Prisma reached the client row but the step read
      // failed. Fall through to a dev-mock empty-state so the operator
      // sees the same EmptyState surface they would for a fresh tenant.
    }
  }

  if (stepSummaries.length === 0) {
    if (!isDatabaseConfigured) {
      // Mock fallback: match the URL clientId against the dev-mock
      // fixtures so the operator sees a populated 12-step matrix in
      // dev-mock mode.
      const mockMatch =
        [MOCK_CLIENT, MOCK_SECONDARY_CLIENT].find((m) => m.id === params.clientId) ??
        MOCK_CLIENT;
      const now = Date.now();
      const mockLast = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
      progressSteps = WIZARD_STEP_NUMBERS.map((n) => {
        const def = getStepDefinition(n as WizardStepNumber);
        return {
          number: def.number,
          key: def.key,
          label: def.label,
          visible: !def.v11Deferred,
          autoConfigured: def.v11Deferred,
          v11Deferred: def.v11Deferred,
        };
      });
      stepSummaries = WIZARD_STEP_NUMBERS.map((n) => {
        const def = getStepDefinition(n as WizardStepNumber);
        return {
          key: def.key,
          number: def.number,
          label: def.label,
          block: def.block,
          v11Deferred: def.v11Deferred,
          status: def.v11Deferred ? null : 'approved',
          submittedAt: def.v11Deferred ? null : mockLast,
          approvedAt: def.v11Deferred ? null : mockLast,
          activeForBot: !def.v11Deferred,
          lastUpdatedAt: def.v11Deferred ? null : mockLast,
        };
      });
      lastUpdated = mockLast;
    }
    // KAIA-13758 — when Prisma returned successfully with zero steps we
    // intentionally render the existing 'Sin datos de pasos' empty state
    // (see render block below), NOT the MOCK_* fallback. The previous
    // `stepSummaries.length === 0` gate here was the bug the audit
    // flagged in KAIA-13753.
  }

  const completedSteps = stepSummaries.filter(
    (s) => !s.v11Deferred && s.status === 'approved',
  ).length;
  const totalTrackSteps = stepSummaries.filter((s) => !s.v11Deferred).length;

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link
          href={`/admin/portal/${params.clientId}`}
          className="hover:text-kairikos-text"
        >
          ← Volver al cliente
        </Link>
      </div>

      <PageHeading
        eyebrow="Operador · wizard de configuración"
        title={`Wizard · ${companyName}`}
        description={
          email
            ? `${email} · Plan ${TIER_LABEL[tier] ?? tier} · ${completedSteps}/${totalTrackSteps} pasos aprobados`
            : `Plan ${TIER_LABEL[tier] ?? tier} · ${completedSteps}/${totalTrackSteps} pasos aprobados`
        }
        actions={
          <Link
            href="/admin/portal/wizard-funnel"
            className="btn-ghost"
            data-testid="admin-wizard-funnel-link"
          >
            Ver embudo de cohortes →
          </Link>
        }
      />

      <section aria-label="Progreso por bloques" data-testid="admin-wizard-block-progress">
        <WizardBlockProgress steps={progressSteps} currentStepNumber={1} />
      </section>

      <section
        className="card overflow-x-auto"
        aria-label="Listado de pasos del wizard"
        data-testid="admin-wizard-step-list"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Pasos del wizard</h2>
          {lastUpdated ? (
            <span className="text-xs text-kairikos-muted">
              Última edición {formatRelative(lastUpdated)}
            </span>
          ) : null}
        </header>

        {stepSummaries.length === 0 ? (
          <EmptyState
            title="Sin datos de pasos"
            description={
              foundInDb
                ? 'La base de datos está configurada pero no hay pasos guardados para este cliente.'
                : 'No hay base de datos configurada; los datos del wizard no están disponibles.'
            }
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-kairikos-muted">
                <th scope="col" className="pb-3 pr-4">Paso</th>
                <th scope="col" className="pb-3 pr-4">Bloque</th>
                <th scope="col" className="pb-3 pr-4">Estado</th>
                <th scope="col" className="pb-3 pr-4">Última edición</th>
                <th scope="col" className="pb-3">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kairikos-border">
              {stepSummaries.map((step) => (
                <tr
                  key={step.key}
                  data-testid={`admin-wizard-step-row-${step.key}`}
                  data-step-key={step.key}
                  data-step-status={step.status ?? 'none'}
                  data-v11-deferred={step.v11Deferred ? 'true' : 'false'}
                >
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          step.v11Deferred
                            ? 'bg-kairikos-border text-kairikos-muted'
                            : 'bg-kairikos-accent/20 text-kairikos-accent'
                        }`}
                      >
                        {step.number}
                      </span>
                      <span className="font-medium">{step.label}</span>
                      {step.v11Deferred ? (
                        <span className="pill-muted text-[10px]">Próximamente</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-kairikos-muted">
                    {BLOCK_LABEL[step.block] ?? step.block}
                  </td>
                  <td className="py-3 pr-4">
                    {step.status ? (
                      <span
                        className={STATUS_PILL[step.status] ?? 'pill-muted'}
                        data-testid={`admin-wizard-step-status-${step.key}`}
                      >
                        {STATUS_LABEL[step.status] ?? step.status}
                      </span>
                    ) : step.v11Deferred ? (
                      <span className="pill-muted">v1.1</span>
                    ) : (
                      <span className="pill-muted">Sin guardar</span>
                    )}
                    {step.activeForBot ? (
                      <span className="ml-2 pill-success text-[10px]">Activo</span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4 text-kairikos-muted">
                    {formatRelative(step.lastUpdatedAt)}
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/admin/portal/${params.clientId}/wizard/${step.key}`}
                      className="text-kairikos-accent2 underline"
                      data-testid={`admin-wizard-step-open-${step.key}`}
                    >
                      {step.v11Deferred ? 'Ver detalle' : 'Revisar'} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-kairikos-muted">
        Como operador, puedes revisar y aprobar cada paso del wizard de este cliente. El
        cliente verá los cambios en su portal en cuanto se actualice la versión activa. El
        paso 12 está marcado como Próximamente y se activará en v1.1.
      </p>
    </div>
  );
}
