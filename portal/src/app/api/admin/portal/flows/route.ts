import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { MOCK_FLOW_HEALTH_ROWS, type FlowHealthRow } from '@/lib/flow-health';

// GET /api/admin/portal/flows
// Returns per-client flow health for the operator dashboard (KAIA-1060 / KAIA-1072).
// Auth: operator session OR x-kaia-operator-key header matching KAIA_OPERATOR_API_KEY
// (both paths handled by authenticateAdminRequest).

const STUCK_DAYS = 3;

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(MOCK_FLOW_HEALTH_ROWS);
  }

  try {
    const clients = await prisma.chatbotClient.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        companyName: true,
        name: true,
        tier: true,
        activities: {
          orderBy: { completedAt: 'desc' },
          take: 1,
          select: { completedAt: true, milestone: true },
        },
        n8nExecutions: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { status: true, startedAt: true },
        },
      },
    });

    const rows: FlowHealthRow[] = clients
      .map((c) => {
        const lastActivityDate = c.activities[0]?.completedAt ?? null;
        const lastMilestone = c.activities[0]?.milestone ?? null;
        const days = lastActivityDate
          ? Math.floor((Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const stuck = days !== null && days > STUCK_DAYS;

        const lastExec = c.n8nExecutions[0] ?? null;
        const lastN8nStatus: FlowHealthRow['lastN8nStatus'] =
          lastExec?.status === 'success'
            ? 'success'
            : lastExec?.status === 'failed'
              ? 'failed'
              : 'unknown';

        return {
          id: c.id,
          companyName: c.companyName ?? c.name,
          tier: c.tier,
          currentMilestone: lastMilestone,
          daysInMilestone: days,
          lastActivityAt: lastActivityDate?.toISOString() ?? null,
          stuck,
          lastN8nStatus,
          lastN8nAt: lastExec?.startedAt?.toISOString() ?? null,
        } satisfies FlowHealthRow;
      })
      .sort((a, b) => {
        if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
        const ad = a.daysInMilestone ?? -1;
        const bd = b.daysInMilestone ?? -1;
        return bd - ad;
      });

    return NextResponse.json(rows);
  } catch (err) {
    console.error('[GET /api/admin/portal/flows]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
