// Mock data for the operator config review tab (KAIA-1267).
// Consumed by src/app/admin/portal/[clientId]/page.tsx when tab=config.
//
// Once the Backend Developer lands GET /api/admin/portal/wizard/:clientId/:step
// and GET /api/admin/portal/clients/:id/config, the page should switch
// from these mocks to live data. The TypeScript shapes defined here are
// the contract the frontend expects from those endpoints.

export type ChannelStatus = 'active' | 'inactive' | 'pending';

export interface ChannelConfig {
  channel: 'whatsapp' | 'web' | 'instagram';
  label: string;
  status: ChannelStatus;
  connectedAt: string | null;
}

export type ConfigStepReviewStatus = 'pending' | 'approved' | 'changes_requested';

export interface ConfigStepReview {
  step: string;
  stepLabel: string;
  status: ConfigStepReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

export interface OperatorConfigData {
  channels: ChannelConfig[];
  stepReviews: ConfigStepReview[];
}

const ACME_ID = '00000000-0000-0000-0000-000000000001';
const GLOBEX_ID = '00000000-0000-0000-0000-000000000002';

export const MOCK_OPERATOR_CONFIG: Record<string, OperatorConfigData> = {
  [ACME_ID]: {
    channels: [
      { channel: 'whatsapp', label: 'WhatsApp', status: 'active', connectedAt: '2026-05-29T09:00:00.000Z' },
      { channel: 'web', label: 'Web Widget', status: 'active', connectedAt: '2026-05-29T09:05:00.000Z' },
      { channel: 'instagram', label: 'Instagram DM', status: 'inactive', connectedAt: null },
    ],
    stepReviews: [
      {
        step: 'lead_captured',
        stepLabel: 'Lead capturado',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-22T10:00:00.000Z',
        reviewNotes: 'Datos de contacto verificados.',
      },
      {
        step: 't0_kickoff',
        stepLabel: 'T+0 Bienvenida',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-22T11:00:00.000Z',
        reviewNotes: 'Email de bienvenida enviado, cliente accedió al portal.',
      },
      {
        step: 't3_intake',
        stepLabel: 'T+3 Configuración inicial',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-25T11:30:00.000Z',
        reviewNotes: 'FAQ y casos de derivación configurados y aprobados.',
      },
      {
        step: 't7_demo',
        stepLabel: 'T+7 Puesta en producción',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-29T09:30:00.000Z',
        reviewNotes: 'Chatbot conectado a WhatsApp y web. Supervisión 24h activa.',
      },
      {
        step: 't14_go_live',
        stepLabel: 'T+14 Revisión y optimización',
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      },
      {
        step: 'active',
        stepLabel: 'Producción activa',
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      },
    ],
  },
  [GLOBEX_ID]: {
    channels: [
      { channel: 'whatsapp', label: 'WhatsApp', status: 'active', connectedAt: '2026-05-24T10:00:00.000Z' },
      { channel: 'web', label: 'Web Widget', status: 'pending', connectedAt: null },
      { channel: 'instagram', label: 'Instagram DM', status: 'inactive', connectedAt: null },
    ],
    stepReviews: [
      {
        step: 'lead_captured',
        stepLabel: 'Lead capturado',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-18T10:00:00.000Z',
        reviewNotes: 'Datos de contacto verificados.',
      },
      {
        step: 't0_kickoff',
        stepLabel: 'T+0 Bienvenida',
        status: 'approved',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-18T11:00:00.000Z',
        reviewNotes: 'Email de bienvenida enviado.',
      },
      {
        step: 't3_intake',
        stepLabel: 'T+3 Configuración inicial',
        status: 'changes_requested',
        reviewedBy: 'operator@kairikos.com',
        reviewedAt: '2026-05-21T14:00:00.000Z',
        reviewNotes: 'Faltan definir los horarios de atención al cliente para el bot.',
      },
      {
        step: 't7_demo',
        stepLabel: 'T+7 Puesta en producción',
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      },
      {
        step: 't14_go_live',
        stepLabel: 'T+14 Revisión y optimización',
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      },
      {
        step: 'active',
        stepLabel: 'Producción activa',
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      },
    ],
  },
};

export const DATE_SHORT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export const CHANNEL_STATUS_LABEL: Record<ChannelStatus, string> = {
  active: 'Activo',
  inactive: 'Inactivo',
  pending: 'Pendiente',
};

export const CHANNEL_STATUS_PILL: Record<ChannelStatus, string> = {
  active: 'pill-success',
  inactive: 'pill-muted',
  pending: 'pill-warning',
};

export const STEP_REVIEW_STATUS_LABEL: Record<ConfigStepReviewStatus, string> = {
  pending: 'Pendiente de revisión',
  approved: 'Aprobado',
  changes_requested: 'Cambios solicitados',
};

export const STEP_REVIEW_STATUS_PILL: Record<ConfigStepReviewStatus, string> = {
  pending: 'pill-warning',
  approved: 'pill-success',
  changes_requested: 'pill-danger',
};
