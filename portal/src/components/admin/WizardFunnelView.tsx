import type { ChatbotTier } from '@/types/portal';
import { EmptyState } from '@/components/portal/EmptyState';
import {
  getWizardFunnelData,
  VERTICAL_LABEL,
  TIER_LABEL,
  STEP_LABELS,
  TIME_WINDOW_OPTIONS,
  VERTICAL_OPTIONS,
  TIER_OPTIONS,
  type WizardFunnelParams,
  type FunnelVertical,
  type FunnelTimeWindow,
  type WizardFunnelStep,
} from '@/lib/wizard-funnel-data';
import Link from 'next/link';

interface WizardFunnelViewProps {
  params: WizardFunnelParams;
  basePath: string;
}

function formatPct(value: number): string {
  return `${value}%`;
}

function FunnelBar({ pct, label, color }: { pct: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 text-right text-xs text-kairikos-muted shrink-0">{label}</span>
      <div className="flex-1 h-5 rounded-full bg-kairikos-surface2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.max(pct, 1)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function StepFunnelRow({ step, maxReached, index }: { step: WizardFunnelStep; maxReached: number; index: number }) {
  const pctReached = maxReached > 0 ? Math.round((step.reached / maxReached) * 100) : 0;
  const barColor = index < 4 ? '#7C5CFF' : index < 8 ? '#3DC7F6' : '#34D399';
  const abandonColor = '#F87171';

  return (
    <tr className="border-t border-kairikos-border/60">
      <td className="py-3 pr-4 align-top">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kairikos-surface2 text-xs font-bold text-kairikos-muted">
            {step.stepKey}
          </span>
          <span className="text-sm font-medium">{step.stepLabel}</span>
        </div>
      </td>
      <td className="py-3 pr-4 align-top whitespace-nowrap">
        <span className="text-sm font-semibold tabular-nums">{step.reached}</span>
      </td>
      <td className="py-3 pr-4 align-top w-1/3 min-w-[120px]">
        <div className="flex flex-col gap-1">
          <FunnelBar pct={pctReached} label="" color={barColor} />
        </div>
      </td>
      <td className="py-3 pr-4 align-top whitespace-nowrap">
        {step.abandoned > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold tabular-nums text-kairikos-danger">{step.abandoned}</span>
            <span className="text-xs text-kairikos-muted">
              ({step.reached > 0 ? Math.round((step.abandoned / step.reached) * 100) : 0}%)
            </span>
          </div>
        ) : (
          <span className="text-sm text-kairikos-muted">—</span>
        )}
      </td>
      <td className="py-3 align-top whitespace-nowrap">
        <span className="text-sm tabular-nums text-kairikos-success">{formatPct(step.completionRate)}</span>
      </td>
    </tr>
  );
}

function FilterLink({
  href,
  label,
  active,
  testId,
}: {
  href: string;
  label: string;
  active: boolean;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      className={active ? 'btn-primary' : 'btn-ghost'}
      data-testid={testId}
      aria-pressed={active}
    >
      {label}
    </Link>
  );
}

export function WizardFunnelView({ params, basePath }: WizardFunnelViewProps) {
  const data = getWizardFunnelData(params);

  const maxReached = data.steps.length > 0 ? data.steps[0].reached : 1;

  const filterHref = (overrides: Partial<WizardFunnelParams>) => {
    const merged = { ...params, ...overrides };
    const sp = new URLSearchParams();
    sp.set('tab', 'wizard-funnel');
    if (merged.vertical !== 'all') sp.set('vertical', merged.vertical);
    if (merged.tier !== 'all') sp.set('tier', merged.tier);
    if (merged.timeWindow !== '30d') sp.set('time', merged.timeWindow);
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-kairikos-border bg-kairikos-surface p-4">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Iniciaron</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.totalStarted}</p>
        </div>
        <div className="rounded-2xl border border-kairikos-border bg-kairikos-surface p-4">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">En progreso</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-kairikos-warning">{data.totalInProgress}</p>
        </div>
        <div className="rounded-2xl border border-kairikos-border bg-kairikos-surface p-4">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Abandonaron</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-kairikos-danger">{data.totalAbandoned}</p>
        </div>
        <div className="rounded-2xl border border-kairikos-border bg-kairikos-surface p-4">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Completaron</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-kairikos-success">{data.totalCompleted}</p>
          <p className="text-xs text-kairikos-muted">{formatPct(data.overallCompletionRate)} de finalización</p>
        </div>
      </div>

      <nav
        aria-label="Filtros del embudo"
        className="card flex flex-wrap items-center gap-2 p-3"
        data-testid="funnel-filter-bar"
      >
        <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-kairikos-muted">Ventana</span>
        {TIME_WINDOW_OPTIONS.map((opt) => (
          <FilterLink
            key={opt.value}
            href={filterHref({ timeWindow: opt.value })}
            label={opt.label}
            active={params.timeWindow === opt.value}
            testId={`funnel-filter-time-${opt.value}`}
          />
        ))}
        <span className="ml-2 mr-1 text-xs font-semibold uppercase tracking-wider text-kairikos-muted">Vertical</span>
        {VERTICAL_OPTIONS.map((opt) => (
          <FilterLink
            key={opt.value}
            href={filterHref({ vertical: opt.value as FunnelVertical | 'all' })}
            label={opt.label}
            active={params.vertical === opt.value}
            testId={`funnel-filter-vertical-${opt.value}`}
          />
        ))}
        <span className="ml-2 mr-1 text-xs font-semibold uppercase tracking-wider text-kairikos-muted">Plan</span>
        {TIER_OPTIONS.map((opt) => (
          <FilterLink
            key={opt.value}
            href={filterHref({ tier: opt.value as ChatbotTier | 'all' })}
            label={opt.label}
            active={params.tier === opt.value}
            testId={`funnel-filter-tier-${opt.value}`}
          />
        ))}
      </nav>

      {data.steps.length === 0 ? (
        <EmptyState
          title="Sin datos de embudo"
          description="No hay datos de cohorte disponibles para los filtros seleccionados."
        />
      ) : (
        <section
          className="card overflow-hidden p-0"
          aria-label="Embudo de configuración por pasos"
          data-testid="funnel-step-table"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="bg-kairikos-surface2 text-left text-xs uppercase tracking-wider text-kairikos-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">Paso</th>
                  <th scope="col" className="px-4 py-3">Alcanzaron</th>
                  <th scope="col" className="px-4 py-3 w-1/3 min-w-[120px]">Proporción</th>
                  <th scope="col" className="px-4 py-3">Abandonaron</th>
                  <th scope="col" className="px-4 py-3">Retención</th>
                </tr>
              </thead>
              <tbody>
                {data.steps.map((step, i) => (
                  <StepFunnelRow key={step.stepKey} step={step} maxReached={maxReached} index={i} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" aria-label="Desglose por vertical" data-testid="funnel-vertical-breakdown">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">Desglose por vertical</h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[400px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-kairikos-muted">
              <tr>
                <th scope="col" className="pb-2 pr-4">Vertical</th>
                <th scope="col" className="pb-2 pr-4">Iniciaron</th>
                <th scope="col" className="pb-2 pr-4">Completaron</th>
                <th scope="col" className="pb-2">Abandonaron</th>
              </tr>
            </thead>
            <tbody>
              {(Object.entries(data.byVertical) as [FunnelVertical, { started: number; completed: number; abandoned: number }][]).map(
                ([key, vals]) => (
                  <tr key={key} className="border-t border-kairikos-border/60">
                    <td className="py-2.5 pr-4 font-medium">{VERTICAL_LABEL[key]}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{vals.started}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-kairikos-success">{vals.completed}</td>
                    <td className="py-2.5 tabular-nums text-kairikos-danger">{vals.abandoned}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-label="Desglose por plan" data-testid="funnel-tier-breakdown">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">Desglose por plan</h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[400px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-kairikos-muted">
              <tr>
                <th scope="col" className="pb-2 pr-4">Plan</th>
                <th scope="col" className="pb-2 pr-4">Iniciaron</th>
                <th scope="col" className="pb-2 pr-4">Completaron</th>
                <th scope="col" className="pb-2">Abandonaron</th>
              </tr>
            </thead>
            <tbody>
              {(Object.entries(data.byTier) as [ChatbotTier, { started: number; completed: number; abandoned: number }][]).map(
                ([key, vals]) => (
                  <tr key={key} className="border-t border-kairikos-border/60">
                    <td className="py-2.5 pr-4 font-medium">{TIER_LABEL[key] ?? key}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{vals.started}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-kairikos-success">{vals.completed}</td>
                    <td className="py-2.5 tabular-nums text-kairikos-danger">{vals.abandoned}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
