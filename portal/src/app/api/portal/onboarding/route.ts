import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { handleGoLiveReady, handleSnooze } from '@/lib/onboarding-actions';
// MOCK_BILLING re-exported as MOCK_BILLING_EXPORT for the billing route.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MILESTONE_STEP: Record<string, { id: 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'; label: string }> = {
  'T+0': { id: 't_plus_0', label: 'Bienvenida y acceso al portal' },
  'T+3': { id: 't_plus_3', label: 'Configuración inicial' },
  'T+7': { id: 't_plus_7', label: 'Puesta en producción' },
  'T+14': { id: 't_plus_14', label: 'Revisión y optimización' },
};

export async function GET(_req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json({ timeline: MOCK_TIMELINE });
  }
  const rows = await prisma.chatbotActivity.findMany({
    where: { clientId: resolved.clientId },
    orderBy: { completedAt: 'asc' },
    select: { id: true, milestone: true, completedAt: true, notes: true },
  });
  return NextResponse.json({
    timeline: rows.map((r) => {
      const def = MILESTONE_STEP[r.milestone] ?? { id: 't_plus_0' as const, label: r.milestone };
      return {
        id: r.id,
        step: def.id,
        label: def.label,
        description: r.notes ?? '',
        occurredAt: r.completedAt?.toISOString() ?? null,
        status: r.completedAt ? 'done' : 'current',
      };
    }),
  });
}

// =============================================================================
// POST /api/portal/onboarding — unified dispatcher for KAIA-1062 actions.
//
// The same handler logic also lives at the explicit subroutes
// `/api/portal/onboarding/snooze` and `/api/portal/onboarding/go-live-ready`
// (one route per issue spec) — both forward to the shared handlers in
// `lib/onboarding-actions.ts`. The two URL shapes are equivalent for
// clients; keeping the unified POST here means the spec's "frontend calls
// POST /api/portal/onboarding with { action }" wording is honoured too.
// =============================================================================

interface SnoozeBody {
  action?: unknown;
  milestoneId?: unknown;
  days?: unknown;
}

interface GoLiveReadyBody {
  state?: unknown;
}

export async function POST(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  if (body.action === 'snooze') {
    return handleSnooze(resolved.clientId, {
      milestoneId: typeof body.milestoneId === 'string' ? body.milestoneId : '',
      days: typeof body.days === 'number' ? body.days : 1,
    });
  }
  if (body.state === 'go-live-ready') {
    return handleGoLiveReady(resolved.clientId, {});
  }
  return NextResponse.json(
    {
      error: 'bad_request',
      detail: 'action must be "snooze" or state must be "go-live-ready"',
    },
    { status: 400 },
  );
}

// We import MOCK_TIMELINE from portal-data only in the GET branch to
// avoid pulling the mock fixture in cold code paths.
import { MOCK_TIMELINE } from '@/lib/portal-data';
