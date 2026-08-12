import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  MOCK_FLOW_ACTIVITY,
  MOCK_N8N_EXECUTIONS,
  type FlowActivityEntry,
  type N8nExecutionSummary,
  type FlowHealthRow,
} from '@/lib/flow-health';

// GET /api/admin/portal/clients/[id]/flow
// Returns per-client flow history for the operator detail view (KAIA-1060 / KAIA-1072).
// Auth: operator session OR x-kaia-operator-key header matching KAIA_OPERATOR_API_KEY
// (both paths handled by authenticateAdminRequest).

const STUCK_DAYS = 3;

interface FlowDetailResponse {
  client: Pick<FlowHealthRow, 'id' | 'companyName' | 'tier' | 'currentMilestone' | 'daysInMilestone' | 'lastActivityAt' | 'stuck'>;
  executions: N8nExecutionSummary[];
  activity: FlowActivityEntry[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const clientId = params.id;

  if (!isDatabaseConfigured) {
    const activity = MOCK_FLOW_ACTIVITY[clientId] ?? [];
    const executions = MOCK_N8N_EXECUTIONS.filter((e) => e.clientId === clientId);
    return NextResponse.json({
      client: { id: clientId, companyName: 'Mock Client', tier: 'starter', currentMilestone: null, daysInMilestone: null, lastActivityAt: null, stuck: false },
      executions,
      activity,
    } satisfies FlowDetailResponse);
  }

  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        companyName: true,
        name: true,
        tier: true,
        activities: {
          orderBy: { completedAt: 'asc' },
          select: { id: true, milestone: true, completedAt: true, notes: true },
        },
        n8nExecutions: {
          orderBy: { startedAt: 'desc' },
          take: 50,
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
        },
      },
    });

    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const lastActivity = client.activities.at(-1)?.completedAt ?? null;
    const lastMilestone = client.activities.at(-1)?.milestone ?? null;
    const days = lastActivity
      ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const milestoneActivity: FlowActivityEntry[] = client.activities
      .filter((a) => a.completedAt)
      .map((a) => ({
        id: `fa_db_${a.id}`,
        kind: 'milestone' as const,
        label: a.milestone,
        occurredAt: a.completedAt!.toISOString(),
        status: 'success' as const,
        detail: a.notes ?? null,
      }));

    const n8nActivity: FlowActivityEntry[] = client.n8nExecutions.map((e) => ({
      id: `n8n_${e.id}`,
      kind: 'n8n_execution' as const,
      label: `n8n: ${e.workflow}`,
      occurredAt: (e.finishedAt ?? e.startedAt).toISOString(),
      status: e.status === 'success' ? 'success' : e.status === 'failed' ? 'failed' : 'info',
      detail: e.errorMessage ?? null,
    }));

    const activity = [...milestoneActivity, ...n8nActivity].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    ).slice(0, 100);

    const executions: N8nExecutionSummary[] = client.n8nExecutions.map((e) => ({
      id: e.id,
      clientId: e.clientId ?? clientId,
      clientName: e.clientName ?? client.companyName ?? client.name,
      workflow: e.workflow,
      milestone: e.milestone,
      status: e.status as N8nExecutionSummary['status'],
      startedAt: e.startedAt.toISOString(),
      finishedAt: e.finishedAt?.toISOString() ?? null,
      errorCode: e.errorCode,
      errorMessage: e.errorMessage,
    }));

    return NextResponse.json({
      client: {
        id: client.id,
        companyName: client.companyName ?? client.name,
        tier: client.tier,
        currentMilestone: lastMilestone,
        daysInMilestone: days,
        lastActivityAt: lastActivity?.toISOString() ?? null,
        stuck: days !== null && days > STUCK_DAYS,
      },
      executions,
      activity,
    } satisfies FlowDetailResponse);
  } catch (err) {
    console.error('[GET /api/admin/portal/clients/[id]/flow]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
