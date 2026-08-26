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
    ...over,
  };
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
  state.leadFindMany.mockResolvedValue([]);
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
    expect(result).toEqual({ ok: true, sent: 0, failed: 0, capReached: true });
    expect(state.leadFindMany).not.toHaveBeenCalled();
  });

  it('caps the lead query to the remaining daily budget', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY - 3);
    await runProspectingContact(prisma, campaign(), NOW);
    expect(state.leadFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it('reports capReached true once today\'s successful sends reach the ceiling', async () => {
    state.auditCount.mockResolvedValue(MAX_AUTO_CONTACTS_PER_DAY - 1);
    state.leadFindMany.mockResolvedValue([lead()]);
    const result = await runProspectingContact(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: true, sent: 1, failed: 0, capReached: true });
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
    state.leadFindMany.mockResolvedValue([lead()]);
    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_id_1',
      '+34600000001',
      expect.objectContaining({ name: 'prospecting_first_contact', bodyParams: ['Ferretería Central', 'Peluquería Aurora'] }),
    );
    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { status: 'contactado', contactedAt: NOW, autoContactError: null },
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
    expect(result).toEqual({ ok: true, sent: 1, failed: 0, capReached: false });
  });

  it('falls back to "equipo" when Google never gave a contact name', async () => {
    state.leadFindMany.mockResolvedValue([lead({ contactName: null })]);
    await runProspectingContact(prisma, campaign(), NOW);
    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_id_1',
      '+34600000001',
      expect.objectContaining({ bodyParams: ['equipo', 'Peluquería Aurora'] }),
    );
  });

  it('a send failure increments autoContactAttempts and records the error, without touching lead status', async () => {
    state.leadFindMany.mockResolvedValue([lead({ autoContactAttempts: 1 })]);
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: '(#131047) re-engagement required', code: 131047 });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(state.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: { autoContactAttempts: 2, autoContactError: '(#131047) re-engagement required' },
    });
    expect(state.leadAuditCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, sent: 0, failed: 1, capReached: false });
  });

  it('processes multiple leads independently — one failure does not stop the next send', async () => {
    state.leadFindMany.mockResolvedValue([lead({ id: 'lead_1' }), lead({ id: 'lead_2' })]);
    mockState.sendTemplate.mockResolvedValueOnce({ ok: false, error: 'boom' }).mockResolvedValueOnce({ ok: true, data: {} });

    const result = await runProspectingContact(prisma, campaign(), NOW);

    expect(result).toEqual({ ok: true, sent: 1, failed: 1, capReached: false });
  });
});
