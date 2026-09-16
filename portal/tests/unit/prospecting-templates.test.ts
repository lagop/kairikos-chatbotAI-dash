// =============================================================================
// Unit tests for src/lib/prospecting-templates.ts — the 3 MARKETING
// templates for "Prospección con IA" cold outreach, submitted to Meta.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  createMessageTemplate: vi.fn(),
  metaSenderFor: vi.fn(),
  markConnectionNeedsReconnect: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
  isAccessTokenError: (r: { code?: number }) => r.code === 190,
}));

vi.mock('@/lib/whatsapp-health', () => ({
  markConnectionNeedsReconnect: (...a: unknown[]) => mockState.markConnectionNeedsReconnect(...a),
}));

// recall-templates.ts (de donde se reutiliza namesAlreadySubmitted, sin
// duplicar la ventana de reintento de 24h) importa RECALL_TEMPLATES de
// este módulo a nivel de módulo — necesita la forma completa o revienta
// al cargar, aunque este archivo no pruebe nada de recall.
vi.mock('@/lib/recall-messaging', () => ({
  RECALL_TEMPLATES: {
    callerOpen: { name: 'recall_caller_open', languageCode: 'es' },
    callerClosed: { name: 'recall_caller_closed', languageCode: 'es' },
    callerOpenWithNotice: { name: 'recall_caller_open_v2', languageCode: 'es' },
    callerClosedWithNotice: { name: 'recall_caller_closed_v2', languageCode: 'es' },
    ownerMessage: { name: 'recall_owner_message', languageCode: 'es' },
    callerSlots: { name: 'recall_caller_slots', languageCode: 'es' },
    callerSlotsWithNotice: { name: 'recall_caller_slots_v2', languageCode: 'es' },
    ownerCallback: { name: 'recall_owner_callback', languageCode: 'es' },
  },
  metaSenderFor: (...a: unknown[]) => mockState.metaSenderFor(...a),
}));

vi.mock('@/lib/prospecting-contact', () => ({
  PROSPECTING_TEMPLATES: {
    firstContact: { name: 'prospecting_first_contact', languageCode: 'es' },
    followUp1: { name: 'prospecting_follow_up_1', languageCode: 'es' },
    followUp2: { name: 'prospecting_follow_up_2', languageCode: 'es' },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  PROSPECTING_TEMPLATE_DEFINITIONS,
  submitAllProspectingTemplates,
  missingProspectingTemplateDefinitions,
  ensureProspectingTemplatesSubmitted,
} from '@/lib/prospecting-templates';

const state = {
  campaignFindMany: vi.fn(),
  connectionFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  templateUpsert: vi.fn(),
};

const prisma = {
  prospectingCampaign: { findMany: (...a: unknown[]) => state.campaignFindMany(...a) },
  metaChannelConnection: { findMany: (...a: unknown[]) => state.connectionFindMany(...a) },
  whatsappTemplate: {
    findMany: (...a: unknown[]) => state.templateFindMany(...a),
    upsert: (...a: unknown[]) => state.templateUpsert(...a),
  },
} as unknown as PrismaClient;

const CONNECTION = {
  id: 'conn_1',
  clientId: 'client_1',
  wabaId: 'waba_1',
  externalId: 'phone_1',
  status: 'active',
  accessTokenCiphertext: Buffer.from('ct'),
  accessTokenIv: Buffer.from('iv'),
  accessTokenTag: Buffer.from('tag'),
};

beforeEach(() => {
  mockState.createMessageTemplate.mockReset().mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
  mockState.metaSenderFor.mockReset().mockReturnValue({ token: 'tok', phoneNumberId: 'phone_1' });
  mockState.markConnectionNeedsReconnect.mockReset().mockResolvedValue({ flipped: true, notified: true });
  mockState.logError.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
  state.campaignFindMany.mockResolvedValue([{ clientId: 'client_1' }]);
  state.connectionFindMany.mockResolvedValue([CONNECTION]);
  state.templateFindMany.mockResolvedValue([]);
  state.templateUpsert.mockResolvedValue({});
});

describe('PROSPECTING_TEMPLATE_DEFINITIONS', () => {
  it('defines exactly the 3 templates the product actually sends, all Spanish MARKETING — not UTILITY, this is cold outreach with no existing relationship', () => {
    expect(PROSPECTING_TEMPLATE_DEFINITIONS).toHaveLength(3);
    const names = PROSPECTING_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['prospecting_first_contact', 'prospecting_follow_up_1', 'prospecting_follow_up_2']);
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
      expect(def.category).toBe('MARKETING');
    }
  });

  it('gives every UNIQUE {{n}} placeholder a matching example', () => {
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      const uniquePlaceholders = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.bodyExamples).toHaveLength(uniquePlaceholders.size);
    }
  });

  it('never ends on a variable — the Meta rejection (error_subcode 2388299) already hit twice drafting recall\'s templates', () => {
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      expect(def.bodyText.trim().endsWith('}}')).toBe(false);
    }
  });

  it('the two follow-ups offer an explicit way to stop hearing from us — no quick-reply button exists yet, so this is the content substitute', () => {
    const followUp1 = PROSPECTING_TEMPLATE_DEFINITIONS.find((t) => t.name === 'prospecting_follow_up_1');
    expect(followUp1?.bodyText).toContain('no volvemos a escribirte');
  });
});

describe('submitAllProspectingTemplates', () => {
  it('submits all 3 templates to the given WABA', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(3);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const call of mockState.createMessageTemplate.mock.calls) {
      expect(call[0]).toBe('token');
      expect(call[1]).toBe('waba_1');
      expect(call[2].category).toBe('MARKETING');
    }
  });

  it('one rejected template does not stop the others from being submitted', async () => {
    mockState.createMessageTemplate.mockImplementation((_token, _waba, spec) => {
      if (spec.name === 'prospecting_follow_up_2') {
        return Promise.resolve({ ok: false, error: 'invalid wording' });
      }
      return Promise.resolve({ ok: true, data: { status: 'PENDING' } });
    });

    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');

    const failed = outcomes.find((o) => o.name === 'prospecting_follow_up_2');
    expect(failed).toMatchObject({ ok: false, error: 'invalid wording' });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    expect(mockState.logError).toHaveBeenCalledWith(
      'prospecting_templates.submit_failed',
      expect.any(Error),
      expect.objectContaining({ wabaId: 'waba_1', template: 'prospecting_follow_up_2' }),
      'warn',
    );
  });

  it('never throws — a network failure on every call still returns 3 outcomes', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'network down' });
    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });
});

describe('missingProspectingTemplateDefinitions', () => {
  it('las 3 faltan si el espejo está vacío', () => {
    expect(missingProspectingTemplateDefinitions(new Set()).map((t) => t.name)).toEqual([
      'prospecting_first_contact',
      'prospecting_follow_up_1',
      'prospecting_follow_up_2',
    ]);
  });

  it('no repite lo que ya está en el espejo', () => {
    const names = missingProspectingTemplateDefinitions(new Set(['prospecting_first_contact'])).map((t) => t.name);
    expect(names).toEqual(['prospecting_follow_up_1', 'prospecting_follow_up_2']);
  });
});

// 2026-09-16 — el disparador automático que faltaba: hasta ahora
// submitAllProspectingTemplates existía pero nada lo llamaba nunca (ver su
// propio comentario). Mismo contrato que ensureRecallTemplatesSubmitted:
// idempotente, con tope por ciclo, y un rechazo o un token caducado no le
// cuesta el turno a las demás plantillas ni a las demás conexiones.
describe('ensureProspectingTemplatesSubmitted', () => {
  it('solo mira campañas activas, y solo su conexión de WhatsApp', async () => {
    await ensureProspectingTemplatesSubmitted(prisma);
    expect(state.campaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'active' } }),
    );
    expect(state.connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: { in: ['client_1'] }, channel: 'whatsapp', status: 'active' },
      }),
    );
  });

  it('sin campañas activas, no consulta conexiones ni envía nada', async () => {
    state.campaignFindMany.mockResolvedValue([]);
    const result = await ensureProspectingTemplatesSubmitted(prisma);
    expect(state.connectionFindMany).not.toHaveBeenCalled();
    expect(mockState.createMessageTemplate).not.toHaveBeenCalled();
    expect(result).toEqual({ connections: 0, submitted: 0, failed: 0 });
  });

  it('envía solo lo que falta y lo deja en el espejo con el estado que devuelve Meta', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { id: 'tpl_1', status: 'PENDING' } });
    const now = new Date('2026-09-16T10:00:00Z');

    const result = await ensureProspectingTemplatesSubmitted(prisma, { now });

    expect(result).toEqual({ connections: 1, submitted: 3, failed: 0 });
    expect(mockState.createMessageTemplate.mock.calls.map((c) => c[2].name)).toEqual([
      'prospecting_first_contact',
      'prospecting_follow_up_1',
      'prospecting_follow_up_2',
    ]);
    expect(mockState.createMessageTemplate.mock.calls[0][0]).toBe('tok');
    expect(mockState.createMessageTemplate.mock.calls[0][1]).toBe('waba_1');
    expect(state.templateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          clientId: 'client_1',
          connectionId: 'conn_1',
          name: 'prospecting_first_contact',
          metaTemplateId: 'tpl_1',
          status: 'PENDING',
          lastCheckedAt: now,
        }),
      }),
    );
  });

  it('no reenvía nada que ya esté en el espejo', async () => {
    state.templateFindMany.mockResolvedValue([
      { name: 'prospecting_first_contact', status: 'PENDING', lastCheckedAt: new Date() },
      { name: 'prospecting_follow_up_1', status: 'APPROVED', lastCheckedAt: new Date() },
      { name: 'prospecting_follow_up_2', status: 'PENDING', lastCheckedAt: new Date() },
    ]);
    const result = await ensureProspectingTemplatesSubmitted(prisma);
    expect(result).toEqual({ connections: 1, submitted: 0, failed: 0 });
    expect(mockState.createMessageTemplate).not.toHaveBeenCalled();
  });

  it('un rechazo al crear queda como SUBMIT_FAILED con el motivo', async () => {
    mockState.createMessageTemplate.mockImplementation((_t, _w, spec) =>
      spec.name === 'prospecting_follow_up_1'
        ? Promise.resolve({ ok: false, error: 'Invalid parameter' })
        : Promise.resolve({ ok: true, data: { status: 'PENDING' } }),
    );

    const result = await ensureProspectingTemplatesSubmitted(prisma);

    expect(result).toEqual({ connections: 1, submitted: 2, failed: 1 });
    expect(state.templateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: 'prospecting_follow_up_1', status: 'SUBMIT_FAILED', rejectedReason: 'Invalid parameter' }),
      }),
    );
    expect(mockState.logError).toHaveBeenCalledWith(
      'prospecting_templates.ensure_submit_failed',
      expect.any(Error),
      expect.objectContaining({ connectionId: 'conn_1', template: 'prospecting_follow_up_1' }),
      'warn',
    );
  });

  it('un token caducado (code 190) no marca la plantilla: marca la conexión y deja de intentarlo', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'Session has expired', code: 190 });
    const now = new Date('2026-09-16T20:00:00Z');

    const result = await ensureProspectingTemplatesSubmitted(prisma, { now });

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(1);
    expect(state.templateUpsert).not.toHaveBeenCalled();
    expect(mockState.markConnectionNeedsReconnect).toHaveBeenCalledWith(prisma, 'conn_1', 'Session has expired', now);
    expect(result).toEqual({ connections: 1, submitted: 0, failed: 1 });
  });

  it('salta conexiones sin WABA o sin remitente válido', async () => {
    state.connectionFindMany.mockResolvedValue([{ ...CONNECTION, wabaId: null }]);
    const result = await ensureProspectingTemplatesSubmitted(prisma);
    expect(result).toEqual({ connections: 0, submitted: 0, failed: 0 });
    expect(mockState.createMessageTemplate).not.toHaveBeenCalled();

    mockState.metaSenderFor.mockReturnValue(null);
    state.connectionFindMany.mockResolvedValue([CONNECTION]);
    const result2 = await ensureProspectingTemplatesSubmitted(prisma);
    expect(result2).toEqual({ connections: 0, submitted: 0, failed: 0 });
  });

  it('respeta el tope de 20 envíos por ciclo', async () => {
    state.campaignFindMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ clientId: `client_${i}` })),
    );
    state.connectionFindMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ ...CONNECTION, id: `conn_${i}`, clientId: `client_${i}` })),
    );
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });

    const result = await ensureProspectingTemplatesSubmitted(prisma);

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(20);
    expect(result.submitted).toBe(20);
  });
});
