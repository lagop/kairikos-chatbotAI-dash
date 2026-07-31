import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Onboarding · Funnel · Kairikos',
  description:
    'Funnel de altas self-serve: conversiones, drop-off por paso y time-to-active. Vista de operador.',
  alternates: { canonical: '/admin/portal/onboarding-funnel' },
  robots: { index: false, follow: false },
};

const STEP_LABEL: Record<string, string> = {
  signup: 'Registro',
  product: 'Producto',
  config: 'Configuración',
  pago: 'Pago',
  activado: 'Activación',
};

const STEPS = ['signup', 'product', 'config', 'pago', 'activado'] as const;

interface StepAggregate {
  step: string;
  seen: number;
  completed: number;
  dropOffPct: number;
}

function aggregate(rows: Array<{ event: string; sessionToken: string; step: string | null; ts: Date }>): {
  steps: StepAggregate[];
  totalSessions: number;
  activatedSessions: number;
  abandons: number;
  recent: Array<{ sessionToken: string; email: string; status: string; createdAt: Date | null; activationAt: Date | null }>;
} {
  const seenByStep = new Map<string, Set<string>>();
  const completedByStep = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.event === 'step_seen' && row.step) {
      const set = seenByStep.get(row.step) ?? new Set<string>();
      set.add(row.sessionToken);
      seenByStep.set(row.step, set);
    }
    if (row.event === 'step_completed' && row.step) {
      const set = completedByStep.get(row.step) ?? new Set<string>();
      set.add(row.sessionToken);
      completedByStep.set(row.step, set);
    }
  }

  const seenAtSignup = seenByStep.get('signup')?.size ?? 0;
  const aggregateSteps: StepAggregate[] = STEPS.map((step) => {
    const seen = seenByStep.get(step)?.size ?? 0;
    const completed = completedByStep.get(step)?.size ?? 0;
    const dropOffBase = step === 'signup' ? seen : (seenByStep.get(STEPS[STEPS.indexOf(step) - 1] as string)?.size ?? 0);
    const dropOffPct = dropOffBase === 0 ? 0 : Math.round(((dropOffBase - seen) / dropOffBase) * 100);
    return { step, seen, completed, dropOffPct };
  });

  const activatedSessions = (rows.find((row) => row.event === 'activated') ? new Set([rows.find((row) => row.event === 'activated')!.sessionToken]).size : 0);
  const totalSessions = new Set(rows.map((row) => row.sessionToken)).size;
  const abandons = new Set(
    rows.filter((row) => row.event === 'abandoned').map((row) => row.sessionToken),
  ).size;

  return {
    steps: aggregateSteps,
    totalSessions,
    activatedSessions,
    abandons,
    recent: [],
  };
}

function averageTimeToActive(rows: Array<{ sessionToken: string; event: string; step: string | null; ts: Date }>): { count: number; seconds: number | null } {
  const completedBySession = new Map<string, Date>();
  const activatedBySession = new Map<string, Date>();
  for (const row of rows) {
    if (row.event === 'step_completed' && row.step === 'signup') {
      const prev = completedBySession.get(row.sessionToken);
      if (!prev || prev > row.ts) completedBySession.set(row.sessionToken, row.ts);
    }
    if (row.event === 'activated') {
      activatedBySession.set(row.sessionToken, row.ts);
    }
  }
  let totalSec = 0;
  let count = 0;
  for (const [session, activatedAt] of activatedBySession.entries()) {
    const startedAt = completedBySession.get(session);
    if (!startedAt) continue;
    const diff = Math.max(0, Math.round((activatedAt.getTime() - startedAt.getTime()) / 1000));
    totalSec += diff;
    count += 1;
  }
  return { count, seconds: count === 0 ? null : Math.round(totalSec / count) };
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default async function OnboardingFunnelPage() {
  let session;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  if (!session?.isOperator) {
    return (
      <main className="mx-auto max-w-page px-4 py-10 sm:px-6">
        <PageHeading
          title="Acceso restringido"
          description="Esta página es solo para el equipo de Kairikos."
        />
        <Link href="/portal/login" className="btn-primary mt-4">
          Iniciar sesión
        </Link>
      </main>
    );
  }

  if (!isDatabaseConfigured) {
    return (
      <main className="mx-auto max-w-page px-4 py-10 sm:px-6">
        <PageHeading
          title="Funnel de onboarding"
          description="Activa la base de datos para ver los datos del funnel."
        />
      </main>
    );
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.onboardingFunnelEvent.findMany({
    where: { ts: { gte: since } },
    orderBy: { ts: 'desc' },
    take: 5000,
  });
  const recentSessions = await prisma.onboardingSession.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      sessionToken: true,
      email: true,
      status: true,
      createdAt: true,
      activationAt: true,
      productTier: true,
    },
  });

  const agg = aggregate(rows);
  const tta = averageTimeToActive(rows);

  return (
    <main className="mx-auto flex max-w-page flex-col gap-6 px-4 py-10 sm:px-6">
      <PageHeading
        title="Funnel de onboarding"
        description="Self-serve wizard (últimos 30 días)."
      />

      <section className="grid gap-3 sm:grid-cols-4">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-kairikos-muted">Sesiones</p>
          <p className="text-2xl font-bold">{agg.totalSessions}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-kairikos-muted">Activados</p>
          <p className="text-2xl font-bold">{agg.activatedSessions}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-kairikos-muted">Abandonos</p>
          <p className="text-2xl font-bold">{agg.abandons}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-kairikos-muted">Time-to-active</p>
          <p className="text-2xl font-bold" data-testid="funnel-tta">
            {formatDuration(tta.seconds)}
          </p>
          <p className="text-xs text-kairikos-muted">Media ({tta.count} activaciones)</p>
        </div>
      </section>

      <section className="card" aria-labelledby="funnel-dropoff">
        <h2 id="funnel-dropoff" className="text-base font-semibold">
          Drop-off por paso
        </h2>
        <div className="mt-3 grid gap-3">
          {agg.steps.map((step) => (
            <div key={step.step} className="grid gap-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">{STEP_LABEL[step.step] ?? step.step}</span>
                <span className="text-kairikos-muted" data-testid={`funnel-step-${step.step}`}>
                  {step.seen} vistos · {step.completed} completados · {step.dropOffPct}% drop-off
                </span>
              </div>
              <div className="h-2 rounded-full bg-kairikos-border/40">
                <div
                  className="h-2 rounded-full bg-kairikos-accent"
                  style={{ width: `${Math.max(0, Math.min(100, 100 - step.dropOffPct))}%` }}
                  aria-hidden
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="funnel-recent">
        <h2 id="funnel-recent" className="text-base font-semibold">
          Onboardings recientes
        </h2>
        {recentSessions.length === 0 ? (
          <p className="mt-3 text-sm text-kairikos-muted">Sin onboardings en los últimos 30 días.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-kairikos-muted">
              <tr>
                <th className="py-1">Email</th>
                <th className="py-1">Plan</th>
                <th className="py-1">Estado</th>
                <th className="py-1">Creado</th>
                <th className="py-1">Activado</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((row) => (
                <tr key={row.sessionToken} className="border-t border-kairikos-border">
                  <td className="py-2">{row.email}</td>
                  <td className="py-2">{row.productTier ?? '—'}</td>
                  <td className="py-2">
                    <span className={row.status === 'active' ? 'pill-success' : row.status === 'abandoned' ? 'pill-danger' : 'pill-warning'}>
                      {row.status}
                    </span>
                  </td>
                  <td className="py-2 text-kairikos-muted">
                    {row.createdAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '—'}
                  </td>
                  <td className="py-2 text-kairikos-muted">
                    {row.activationAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
