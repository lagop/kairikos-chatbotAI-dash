// Mock data (dev-mock only) + the real read path for the operator
// flow-health dashboard (KAIA-1060 / WP-10).
//
// WP-10 — `getFlowHealthRows()` below is the single source of truth for
// "per-client last activity + last n8n execution", used by BOTH
// GET /api/admin/portal/flows and admin/portal/flows/page.tsx. Before this,
// each had its own inline Prisma query; the route's version correctly
// joined `n8nExecutions`, but the page's never did — every row's
// `lastN8nStatus` was hardcoded to `'unknown'` behind a comment claiming
// the N8nExecution table didn't exist yet (it has, since KAIA-1072), so
// the "Última ejecución n8n" column always read "Sin datos" regardless of
// what actually happened. Two implementations of the same read, one of
// them stale, is exactly the class of bug this consolidation removes.
//
// Mock fixtures are restricted to the dev-mock path (`!isDatabaseConfigured`)
// — the same rule `listAdminClients()` follows (KAIA-13715/13753): a real,
// configured database that returns zero rows is a genuine empty state, not
// a signal to fall back to `MOCK_FLOW_HEALTH_ROWS`.

import type { PrismaClient } from '@prisma/client';

export const STUCK_DAYS = 3;

export interface FlowHealthRow {
  id: string;
  companyName: string;
  tier: string;
  currentMilestone: string | null;
  daysInMilestone: number | null;
  lastActivityAt: string | null;
  stuck: boolean;
  lastN8nStatus: 'success' | 'failed' | 'unknown';
  lastN8nAt: string | null;
}

/**
 * Per-client flow health: last completed onboarding milestone + last n8n
 * execution, sorted stuck-first (then longest-in-milestone first) so the
 * operator sees what needs attention at the top. Callers decide what to do
 * on failure/no-DB — this only runs the query.
 */
export async function getFlowHealthRows(prisma: PrismaClient): Promise<FlowHealthRow[]> {
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

  return clients
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
}

export interface N8nExecutionSummary {
  id: string;
  clientId: string;
  clientName: string;
  workflow: string;
  milestone: string | null;
  status: 'success' | 'failed' | 'running';
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface FlowActivityEntry {
  id: string;
  kind: 'milestone' | 'note' | 'n8n_execution';
  label: string;
  occurredAt: string;
  status: 'success' | 'failed' | 'info';
  detail: string | null;
}

const ACME_ID = '00000000-0000-0000-0000-000000000001';
const GLOBEX_ID = '00000000-0000-0000-0000-000000000002';

const NOW = Date.now();
const daysAgoIso = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const hoursAgoIso = (h: number): string => new Date(NOW - h * 60 * 60 * 1000).toISOString();

export const MOCK_FLOW_HEALTH_ROWS: FlowHealthRow[] = [
  {
    id: ACME_ID,
    companyName: 'Acme Corp',
    tier: 'pro',
    currentMilestone: 'T+14',
    daysInMilestone: 5,
    lastActivityAt: daysAgoIso(5),
    stuck: true,
    lastN8nStatus: 'success',
    lastN8nAt: hoursAgoIso(6),
  },
  {
    id: GLOBEX_ID,
    companyName: 'Globex Inc',
    tier: 'premium',
    currentMilestone: 'T+3',
    daysInMilestone: 1,
    lastActivityAt: daysAgoIso(1),
    stuck: false,
    lastN8nStatus: 'failed',
    lastN8nAt: hoursAgoIso(2),
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    companyName: 'Initech S.L.',
    tier: 'starter',
    currentMilestone: 'T+0',
    daysInMilestone: 2,
    lastActivityAt: daysAgoIso(2),
    stuck: false,
    lastN8nStatus: 'success',
    lastN8nAt: hoursAgoIso(20),
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    companyName: 'Hooli Iberia',
    tier: 'pro',
    currentMilestone: 'T+7',
    daysInMilestone: 6,
    lastActivityAt: daysAgoIso(6),
    stuck: true,
    lastN8nStatus: 'failed',
    lastN8nAt: hoursAgoIso(30),
  },
];

export const MOCK_N8N_EXECUTIONS: N8nExecutionSummary[] = [
  {
    id: 'n8n_001',
    clientId: ACME_ID,
    clientName: 'Acme Corp',
    workflow: 'T+14 revisión',
    milestone: 'T+14',
    status: 'success',
    startedAt: hoursAgoIso(7),
    finishedAt: hoursAgoIso(6),
    errorCode: null,
    errorMessage: null,
  },
  {
    id: 'n8n_002',
    clientId: GLOBEX_ID,
    clientName: 'Globex Inc',
    workflow: 'T+3 configuración inicial',
    milestone: 'T+3',
    status: 'failed',
    startedAt: hoursAgoIso(3),
    finishedAt: hoursAgoIso(2),
    errorCode: 'TIMEOUT',
    errorMessage: 'Supabase insert exceeded 10s en chatbot_activities upsert',
  },
  {
    id: 'n8n_003',
    clientId: '00000000-0000-0000-0000-000000000004',
    clientName: 'Hooli Iberia',
    workflow: 'T+7 go-live webhook',
    milestone: 'T+7',
    status: 'failed',
    startedAt: hoursAgoIso(31),
    finishedAt: hoursAgoIso(30),
    errorCode: 'WEBHOOK_404',
    errorMessage: 'El endpoint POST /api/internal/activity devolvió 404',
  },
  {
    id: 'n8n_004',
    clientId: '00000000-0000-0000-0000-000000000003',
    clientName: 'Initech S.L.',
    workflow: 'T+0 bienvenida',
    milestone: 'T+0',
    status: 'success',
    startedAt: hoursAgoIso(22),
    finishedAt: hoursAgoIso(21),
    errorCode: null,
    errorMessage: null,
  },
];

export const MOCK_FLOW_ACTIVITY: Record<string, FlowActivityEntry[]> = {
  [ACME_ID]: [
    {
      id: 'fa_001',
      kind: 'milestone',
      label: 'T+0 bienvenida enviada',
      occurredAt: daysAgoIso(19),
      status: 'success',
      detail: 'Email magic-link entregado vía Resend.',
    },
    {
      id: 'fa_002',
      kind: 'milestone',
      label: 'T+3 configuración completada',
      occurredAt: daysAgoIso(16),
      status: 'success',
      detail: 'Cliente aprobó FAQ y casos de derivación.',
    },
    {
      id: 'fa_003',
      kind: 'milestone',
      label: 'T+7 go-live',
      occurredAt: daysAgoIso(12),
      status: 'success',
      detail: 'Chatbot conectado a WhatsApp y web.',
    },
    {
      id: 'fa_004',
      kind: 'n8n_execution',
      label: 'n8n: T+14 revisión',
      occurredAt: hoursAgoIso(6),
      status: 'success',
      detail: 'Workflow "T+14 revisión" completado en 38s.',
    },
  ],
  [GLOBEX_ID]: [
    {
      id: 'fa_010',
      kind: 'milestone',
      label: 'T+0 bienvenida enviada',
      occurredAt: daysAgoIso(9),
      status: 'success',
      detail: 'Email magic-link entregado vía Resend.',
    },
    {
      id: 'fa_011',
      kind: 'n8n_execution',
      label: 'n8n: T+3 configuración inicial (fallo)',
      occurredAt: hoursAgoIso(2),
      status: 'failed',
      detail: 'TIMEOUT: Supabase insert excedió 10s.',
    },
  ],
};
