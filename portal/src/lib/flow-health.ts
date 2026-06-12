// Mock data for the operator flow-health dashboard (KAIA-1060).
// Consumed by src/app/admin/portal/flows/page.tsx and the per-client
// flow view on src/app/admin/portal/[clientId]/page.tsx.
//
// Once the Backend Developer lands the dedicated endpoints
//   GET /api/admin/portal/flows
//   GET /api/admin/portal/clients/[id]/flow
// and the Automation Engineer wires n8n execution capture (N8nExecution
// table or POST /api/internal/n8n-execution), the page should switch
// from these mocks to the live data. The TypeScript shapes defined here
// are the contract the frontend expects from those endpoints.

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

const STUCK_DAYS = 3;
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

void STUCK_DAYS;

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
