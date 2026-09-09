// =============================================================================
// Prospección con IA, Fase C — unit tests for src/lib/prospecting-contact.ts
// (runProspectingContact): every gate (consent, auto-pause, live quality
// check, daily cap, per-lead attempt budget) and the send/failure paths.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  sendTemplate: vi.fn(),
  getPhoneNumberInfo: vi.fn(),
  metaSenderFor: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a),
  getPhoneNumberInfo: (...a: unknown[]) => mockState.getPhoneNumberInfo(...a),
}));

vi.mock('@/lib/recall-messaging', () => ({
  metaSenderFor: (...a: unknown[]) => mockState.metaSenderFor(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  runProspectingContact,
  PROSPECTING_CONSENT_VERSION,
  MAX_AUTO_CONTACTS_PER_DAY,
  MAX_AUTO_CONTACT_ATTEMPTS,
  MAX_SEQUENCE_TOUCHES,
  nextSequenceStep,
  type ProspectingContactCampaignInput,
} from '@/lib/prospecting-contact';

const state = {
  connectionFindFirst: vi.fn(),
  connectionUpdate: vi.fn(),
  campaignUpdate: vi.fn(),
  auditCount: vi.fn(),
  clientFindUnique: vi.fn(),
  leadFindMany: vi.fn(),
  leadUpdate: vi.fn(),
  leadAuditCreate: vi.fn(),
};

const mockTx = {
  lead: { update: (...a: unknown[]) => state.leadUpdate(...a) },
  leadAudit: { create: (...a: unknown[]) => state.leadAuditCreate(...a) },
};

const prisma = {
  $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  metaChannelConnection: {
    findFirst: (...a: unknown[]) => state.connectionFindFirst(...a),
    update: (...a: unknown[]) => state.connectionUpdate(...a),
  },
  prospectingCampaign: { update: (...a: unknown[]) => state.campaignUpdate(...a) },
  leadAudit: { count: (...a: unknown[]) => state.auditCount(...a) },
  chatbotClient: { findUnique: (...a: unknown[]) => state.clientFindUnique(...a) },
  lead: {
    findMany: (...a: unknown[]) => state.leadFindMany(...a),
    update: (...a: unknown[]) => state.leadUpdate(...a),
  },
} as unknown as PrismaClient;

const NOW = new Date('2026-09-06T12:00:00.000Z');
const CONNECTION_ROW = { id: 'conn_1', externalId: 'phone_id_1', status: 'active' };
const SENDER = { token: 'tok', phoneNumberId: 'phone_id_1' };

function campaign(over: Partial<ProspectingContactCampaignInput> = {}): ProspectingContactCampaignInput {
  return {
    id: 'campaign_1',
    clientId: 'client_1',
    tenantId: 't1',
    status: 'active',
    consentAcknowledgedAt: NOW,
    consentVersion: PROSPECTING_CONSENT_VERSION,
    autoContactPausedAt: null,
    ...over,
  };
}

function lead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead_1',
    contactPhone: '+34600000001',
    contactName: 'Ferretería Central',
    autoContactAttempts: 0,
    // Fase 3.3 — sin toques todavía: es un primer contacto.
    followUpCount: 0,
    lastAutoContactAt: null,
    ...over,
  };
}

/** Fase 3.3 — runProspectingContact hace ahora DOS consultas de leads
 *  (seguimientos pendientes y primeros contactos) y el reparto del cupo
 *  diario entre las dos es justo lo que hay que poder probar. Se
 *  distinguen por `status`: solo la de primeros contactos filtra 'nuevo'. */
function mockLeads(
  { followUps = [] as unknown[], firstContacts = [] as unknown[] } = {},
) {
  state.leadFindMany.mockImplementation((args: { where?: { status?: string } }) =>
    Promise.resolve(args?.where?.status === 'nuevo' ? firstContacts : followUps),
  );
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.sendTemplate.mockReset();
  mockState.getPhoneNumberInfo.mockReset();
  mockState.metaSenderFor.mockReset();
  mockState.logError.mockReset();

  state.connectionFindFirst.mockResolvedValue(CONNECTION_ROW);
  mockState.metaSenderFor.mockReturnValue(SENDER);
  mockState.getPhoneNumberInfo.mockResolvedValue({ ok: true, data: { quality_rating: 'GREEN' } });
  state.connectionUpdate.mockResolvedValue({});
  state.campaignUpdate.mockResolvedValue({});
  state.auditCount.mockResolvedValue(0);
  state.clientFindUnique.mockResolvedValue({ name: 'Aurora Owner', companyName: 'Peluquería Aurora' });
  mockLeads();
  state.leadUpdate.mockResolvedValue({});
  state.leadAuditCreate.mockResolvedValue({});
  mockState.sendTemplate.mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid_1' }] } });
});

describe('runProspectingContact — gates', () => {
  it('campaign_paused when the campaign itself is not active', async () => {
    const result = await runProspectingContact(prisma, campaign({ status: 'paused' }), NOW);
    expect(result).toEqual({ ok: false, error: 'campaign_paused' });
    expect(state.connectionFindFirst).not.toHaveBeenCalled();
  });

  it('no_consent when consent was never given', async () => {
    const result = await runProspectingContact(prisma, campaign({ consentAcknowledgedAt: null, consentVersion: null }), NOW);
    expect(result).toEqual({ ok: false, error: 'no_consent' });
  });

  it('no_consent when the stored consentVersion is stale — a future copy change forces re-consent automatically', async () => {
    const result = await runProspectingContact(prisma, campaign({ consentVersion: 'v0_old' }), NOW);
    expect(result).toEqual({ ok: false, error: 'no_consent' });
  });

  it('auto_paused when a prior quality-degradation pause has not been cleared by re-consenting', async () => {
    const result = await runProspectingContact(prisma, campaign({ autoContactPausedAt: new Date('2026-09-01') }), NOW);
    expect(result).toEqual({ ok: false, error: 'auto_paused' });
    expect(state.connectionFindFirst).not.toHaveBeenCalled();
  });

  it('no_whatsapp_connection when the client has no active WhatsApp connection', async () => {
    mockState.metaSenderFor.mockReturnValue(null);
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: false, error: 'no_whatsapp_connection' });
    expect(mockState.getPhoneNumberInfo).not.toHaveBeenCalled();
  });
});

describe('runProspectingContact — live quality-rating gate', () => {
  it('quality_check_failed when the live Graph API call itself fails — fails closed, never sends blind', async () => {
    mockState.getPhoneNumberInfo.mockResolvedValue({ ok: false, error: 'graph_down' });
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: false, error: 'quality_check_failed' });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it.each(['YELLOW', 'RED'])('quality_degraded on a live %s rating — auto-pauses the campaign', async (rating) => {
    mockState.getPhoneNumberInfo.mockResolvedValue({ ok: true, data: { quality_rating: rating } });
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: false, error: 'quality_degraded' });
    expect(state.campaignUpdate).toHaveBeenCalledWith({ where: { id: 'campaign_1' }, data: { autoContactPausedAt: NOW } });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('a GREEN rating refreshes the stored MetaChannelConnection.qualityRating mirror as a side effect', async () => {
    await runProspectingContact(prisma, campaign(), NOW);
    expect(state.connectionUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { qualityRating: 'GREEN' } });
  });

  it('never gates on the stale stored qualityRating — only the live fetch matters', async () => {
    // CONNECTION_ROW carries no qualityRating field at all; the gate must
    // still evaluate correctly purely from the live getPhoneNumberInfo call.
    mockState.getPhoneNumberInfo.mockResolvedValue({ ok: true, data: { quality_rating: 'GREEN' } });
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result.ok).toBe(true);
  });
});

describe('runProspectingContact — daily cap', () => {
  it('stops before querying leads once MAX_AUTO_CONTACTS_PER_DAY is already reached today', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY);
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 0, failed: 0, capReached: true });
    expect(state.leadFindMany).not.toHaveBeenCalled();
  });

  it('caps the lead query to the remaining daily budget', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY - 3);
    await runProspectingContact(prisma, campaign(), NOW);
    expect(state.leadFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it('reports capReached true once today\'s successful sends reach the ceiling', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY - 1);
    mockLeads({ firstContacts: [lead()] });
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: true, sent: 1, followedUp: 0, failed: 0, capReached: true });
  });
});

describe('runProspectingContact — candidate selection', () => {
  it('only selects nuevo, outbound leads with a phone that have not exhausted their attempt budget', async () => {
    await runProspectingContact(prisma, campaign(), NOW);
    expect(state.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'client_1',
          source: 'outbound',
          status: 'nuevo',
          contactPhone: { not: null },
          autoContactAttempts: { lt: MAX_AUTO_CONTACT_ATTEMPTS },
        },
      }),
    );
  });
});

describe('runProspectingContact — sending', () => {
  it('sends the template with the prospect name and the client business name, then marks contactado + audits', async () => {
    mockLeads({ firstContacts: [lead()] });
    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_id_1',
      '+34600000001',
      expect.objectContaining({ name: 'prospecting_first_contact', bodyParams: ['Ferretería Central', 'Peluquería Aurora'] }),
    );
    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { followUpCount: 1, lastAutoContactAt: NOW, autoContactError: null, status: 'contactado', contactedAt: NOW },
    });
    expect(state.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead_1',
          action: 'contacted_auto',
          statusBefore: 'nuevo',
          statusAfter: 'contactado',
          actorId: 'system:prospecting',
        }),
      }),
    );
    expect(result).toEqual({ ok: true, sent: 1, followedUp: 0, failed: 0, capReached: false });
  });

  it('falls back to "equipo" when Google never gave a contact name', async () => {
    mockLeads({ firstContacts: [lead({ contactName: null })] });
    await runProspectingContact(prisma, campaign(), NOW);
    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_id_1',
      '+34600000001',
      expect.objectContaining({ bodyParams: ['equipo', 'Peluquería Aurora'] }),
    );
  });

  it('a send failure increments autoContactAttempts and records the error, without touching lead status', async () => {
    mockLeads({ firstContacts: [lead({ autoContactAttempts: 1 })] });
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: '(#131047) re-engagement required', code: 131047 });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { autoContactAttempts: 2, autoContactError: '(#131047) re-engagement required' },
    });
    expect(state.leadAuditCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 0, failed: 1, capReached: false });
  });

  it('processes multiple leads independently — one failure does not stop the next send', async () => {
    mockLeads({ firstContacts: [lead({ id: 'lead_1' }), lead({ id: 'lead_2' })] });
    mockState.sendTemplate.mockResolvedValueOnce({ ok: false, error: 'boom' }).mockResolvedValueOnce({ ok: true, data: {} });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(result).toEqual({ ok: true, sent: 1, followedUp: 0, failed: 1, capReached: false });
  });
});

// =============================================================================
// Fase 3.3 — la secuencia de seguimiento. Lo que se fija aquí es el
// comportamiento del que depende que este producto no queme el número del
// cliente: el corte al responder, que un toque solo se gaste si de verdad
// salió, y que los seguimientos y los primeros contactos compartan el
// mismo cupo diario en vez de sumarse a él.
// =============================================================================

describe('nextSequenceStep', () => {
  it('el primer toque de un lead sin contactar es el primer contacto', () => {
    expect(nextSequenceStep(0)).toMatchObject({ step: 1, template: { name: 'prospecting_first_contact' } });
  });

  it('avanza por la cadencia toque a toque', () => {
    expect(nextSequenceStep(1)).toMatchObject({ step: 2, template: { name: 'prospecting_follow_up_1' }, delayDays: 3 });
    expect(nextSequenceStep(2)).toMatchObject({ step: 3, template: { name: 'prospecting_follow_up_2' }, delayDays: 7 });
  });

  it('agotada la secuencia no hay siguiente toque, no vuelve a empezar', () => {
    expect(nextSequenceStep(MAX_SEQUENCE_TOUCHES)).toBeNull();
    expect(nextSequenceStep(99)).toBeNull();
  });

  it('tres toques es el techo del producto, no un número suelto', () => {
    expect(MAX_SEQUENCE_TOUCHES).toBe(3);
  });
});

describe('runProspectingContact — secuencia de seguimiento', () => {
  it('manda el segundo toque a quien ya recibió el primero, sin tocar contactedAt ni el estado', async () => {
    const contactedAt = new Date('2026-09-01T12:00:00.000Z');
    mockLeads({ followUps: [lead({ followUpCount: 1, lastAutoContactAt: contactedAt })] });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_id_1',
      '+34600000001',
      expect.objectContaining({ name: 'prospecting_follow_up_1' }),
    );
    // contactedAt sigue siendo "la primera vez": leads.ts lo usa para
    // detectar atascos y moverlo en cada toque lo rompería.
    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { followUpCount: 2, lastAutoContactAt: NOW, autoContactError: null },
    });
    expect(state.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'followed_up_auto', statusBefore: 'contactado', statusAfter: 'contactado' }),
      }),
    );
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 1, failed: 0, capReached: false });
  });

  it('nunca busca seguimientos de quien ya respondió — ese es el corte de la secuencia', async () => {
    await runProspectingContact(prisma, campaign(), NOW);
    const followUpQuery = state.leadFindMany.mock.calls.find((c) => c[0]?.where?.status === 'contactado')?.[0];
    expect(followUpQuery.where.repliedAt).toBeNull();
  });

  it('pide cada escalón con su propia espera cumplida, no con una sola fecha para todos', async () => {
    await runProspectingContact(prisma, campaign(), NOW);
    const followUpQuery = state.leadFindMany.mock.calls.find((c) => c[0]?.where?.status === 'contactado')?.[0];
    expect(followUpQuery.where.OR).toEqual([
      { followUpCount: 1, lastAutoContactAt: { lte: new Date('2026-09-03T12:00:00.000Z') } },
      { followUpCount: 2, lastAutoContactAt: { lte: new Date('2026-08-30T12:00:00.000Z') } },
    ]);
  });

  it('un envío fallido no gasta toque: el prospecto no ha recibido nada', async () => {
    mockLeads({ followUps: [lead({ followUpCount: 1, lastAutoContactAt: new Date('2026-09-01') })] });
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'template not approved' });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { autoContactAttempts: 1, autoContactError: 'template not approved' },
    });
    // followUpCount intacto: el escalón se reintenta el tick siguiente.
    expect(state.leadUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ followUpCount: 2 }) }));
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 0, failed: 1, capReached: false });
  });

  it('los seguimientos van primero y consumen el mismo cupo diario que los primeros contactos', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY - 2);
    mockLeads({
      followUps: [
        lead({ id: 'seguimiento_1', followUpCount: 1, lastAutoContactAt: new Date('2026-09-01') }),
        lead({ id: 'seguimiento_2', followUpCount: 2, lastAutoContactAt: new Date('2026-08-25') }),
      ],
      firstContacts: [lead({ id: 'nuevo_1' })],
    });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    // Quedaban 2 de cupo y había 2 seguimientos: el prospecto nuevo no se
    // llega ni a consultar, la secuencia empezada tiene prioridad.
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 2, failed: 0, capReached: true });
    expect(state.leadFindMany).toHaveBeenCalledTimes(1);
    expect(mockState.sendTemplate).toHaveBeenCalledTimes(2);
  });

  it('con cupo de sobra atiende seguimientos y prospectos nuevos en la misma pasada', async () => {
    mockLeads({
      followUps: [lead({ id: 'seguimiento_1', followUpCount: 1, lastAutoContactAt: new Date('2026-09-01') })],
      firstContacts: [lead({ id: 'nuevo_1' })],
    });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(result).toEqual({ ok: true, sent: 1, followedUp: 1, failed: 0, capReached: false });
    // La segunda consulta pide solo lo que queda de cupo tras los seguimientos.
    expect(state.leadFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: MAX_AUTO_CONTACTS_PER_DAY - 1 }),
    );
  });

  it('un lead con la secuencia agotada no recibe nada aunque se cuele en la consulta', async () => {
    mockLeads({ followUps: [lead({ followUpCount: MAX_SEQUENCE_TOUCHES, lastAutoContactAt: new Date('2026-08-01') })] });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, sent: 0, followedUp: 0, failed: 0, capReached: false });
  });
});
