// =============================================================================
// Fase 8 ('recall') — unit tests for src/lib/recall-meta.ts (the
// Coexistence connect: exchange, resolve phone number, persist, bind to
// subscription, advance status).
//
// meta-business.ts and whatsapp-api.ts are mocked at the call level —
// these tests are about recall-meta.ts's OWN logic (which status
// transitions are legal, what gets bound, what happens on each Meta
// failure mode), not the Graph API request shapes those two modules
// already have their own tests for.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  exchangeForLongLivedToken: vi.fn(),
  encryptMetaToken: vi.fn(),
  subscribeWaba: vi.fn(),
  getPhoneNumbersForWaba: vi.fn(),
  getPhoneNumberInfo: vi.fn(),
  syncSmbAppState: vi.fn(),
  deliverChannelEvent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/meta-business', () => ({
  exchangeCodeForToken: (...a: unknown[]) => mockState.exchangeCodeForToken(...a),
  exchangeForLongLivedToken: (...a: unknown[]) => mockState.exchangeForLongLivedToken(...a),
  encryptMetaToken: (...a: unknown[]) => mockState.encryptMetaToken(...a),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  subscribeWaba: (...a: unknown[]) => mockState.subscribeWaba(...a),
  getPhoneNumbersForWaba: (...a: unknown[]) => mockState.getPhoneNumbersForWaba(...a),
  getPhoneNumberInfo: (...a: unknown[]) => mockState.getPhoneNumberInfo(...a),
  syncSmbAppState: (...a: unknown[]) => mockState.syncSmbAppState(...a),
}));

vi.mock('@/lib/channel-webhook', () => ({
  deliverChannelEvent: (...a: unknown[]) => mockState.deliverChannelEvent(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { connectRecallWhatsapp } from '@/lib/recall-meta';

const state = {
  recallSubscriptionFindUnique: vi.fn(),
  recallSubscriptionUpdate: vi.fn(),
  metaChannelConnectionUpsert: vi.fn(),
  metaChannelConnectionUpdate: vi.fn(),
  recallSubscriptionAuditCreate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findUnique: (...a: unknown[]) => state.recallSubscriptionFindUnique(...a),
    update: (...a: unknown[]) => state.recallSubscriptionUpdate(...a),
  },
  metaChannelConnection: {
    upsert: (...a: unknown[]) => state.metaChannelConnectionUpsert(...a),
    update: (...a: unknown[]) => state.metaChannelConnectionUpdate(...a),
  },
  recallSubscriptionAudit: {
    create: (...a: unknown[]) => state.recallSubscriptionAuditCreate(...a),
  },
} as unknown as PrismaClient;

const PARAMS = { clientId: 'client_1', tenantId: null, subscriptionId: 'sub_1', code: 'auth_code', wabaId: 'waba_1' };

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();

  state.recallSubscriptionFindUnique.mockResolvedValue({ id: 'sub_1', clientId: 'client_1', status: 'contract_signed' });
  mockState.exchangeCodeForToken.mockResolvedValue({ accessToken: 'short_lived', expiresIn: 5400 });
  mockState.exchangeForLongLivedToken.mockResolvedValue({ accessToken: 'long_lived', expiresIn: 5183944 });
  mockState.encryptMetaToken.mockReturnValue({ ciphertext: Buffer.from('c'), iv: Buffer.from('i'), tag: Buffer.from('t') });
  mockState.getPhoneNumbersForWaba.mockResolvedValue({ ok: true, data: { data: [{ id: 'phone_1', display_phone_number: '+34 611 22 33 44' }] } });
  mockState.subscribeWaba.mockResolvedValue({ ok: true, data: { success: true } });
  mockState.getPhoneNumberInfo.mockResolvedValue({
    ok: true,
    data: { display_phone_number: '+34 611 22 33 44', verified_name: 'Fontanería Ruiz', quality_rating: 'GREEN', platform_type: 'CLOUD_API' },
  });
  mockState.syncSmbAppState.mockResolvedValue({ ok: true, data: { success: true } });
  mockState.deliverChannelEvent.mockResolvedValue({ ok: true, deliveryId: 'd1', status: 'delivered' });

  state.metaChannelConnectionUpsert.mockResolvedValue({ id: 'conn_1' });
  state.metaChannelConnectionUpdate.mockResolvedValue({});
  state.recallSubscriptionUpdate.mockResolvedValue({ status: 'meta_connected' });
  state.recallSubscriptionAuditCreate.mockResolvedValue({});
});

describe('connectRecallWhatsapp', () => {
  it('connects, binds, and advances contract_signed → meta_connected', async () => {
    const result = await connectRecallWhatsapp(prisma, PARAMS);

    expect(result).toEqual({
      ok: true,
      connectionId: 'conn_1',
      displayPhoneNumber: '+34 611 22 33 44',
      advancedTo: 'meta_connected',
    });
    expect(state.metaChannelConnectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ channel: 'whatsapp', externalId: 'phone_1', isCoexistence: true }),
      }),
    );
    expect(state.recallSubscriptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metaConnectionId: 'conn_1', status: 'meta_connected' }),
      }),
    );
    // NEVER registers the phone number — coexistence forbids it (see
    // meta-business.ts's header). Nothing in this module even imports a
    // register call, but the audit event is what n8n reads to know not
    // to make one either.
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ isCoexistence: true }) }),
    );
  });

  it('rebinding a reconnect does not move status backward or sideways', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 'sub_1', clientId: 'client_1', status: 'active' });
    state.recallSubscriptionUpdate.mockResolvedValue({ status: 'active' });

    const result = await connectRecallWhatsapp(prisma, PARAMS);

    expect(result).toMatchObject({ ok: true, advancedTo: null });
    expect(state.recallSubscriptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { metaConnectionId: 'conn_1' },
      }),
    );
  });

  it('rejects a subscription that belongs to a different client', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 'sub_1', clientId: 'someone_else', status: 'contract_signed' });
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result).toEqual({ ok: false, error: 'subscription_not_found' });
    expect(mockState.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('refuses when the subscription cannot legally bind a Meta connection (paid, or cancelled)', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 'sub_1', clientId: 'client_1', status: 'paid' });
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result).toEqual({ ok: false, error: 'invalid_status' });
    expect(mockState.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('fails cleanly when Meta rejects the code exchange', async () => {
    mockState.exchangeCodeForToken.mockResolvedValue(null);
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result).toEqual({ ok: false, error: 'code_exchange_failed' });
    expect(state.metaChannelConnectionUpsert).not.toHaveBeenCalled();
  });

  it('fails cleanly when the WABA has no phone number to resolve — the coexistence event never carries one', async () => {
    mockState.getPhoneNumbersForWaba.mockResolvedValue({ ok: true, data: { data: [] } });
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result).toEqual({ ok: false, error: 'phone_number_not_found' });
    expect(state.metaChannelConnectionUpsert).not.toHaveBeenCalled();
  });

  it('still connects and binds when subscribeWaba fails — the connection IS valid regardless', async () => {
    mockState.subscribeWaba.mockResolvedValue({ ok: false, error: 'temporarily unavailable' });
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result.ok).toBe(true);
    expect(state.metaChannelConnectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncError: 'temporarily unavailable' }) }),
    );
  });

  it('still connects and binds when the smb_app_state sync fails — best-effort, not a precondition', async () => {
    mockState.syncSmbAppState.mockResolvedValue({ ok: false, error: 'not eligible' });
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result.ok).toBe(true);
  });

  it('still connects and binds when the audit write fails — the bind already succeeded', async () => {
    state.recallSubscriptionAuditCreate.mockRejectedValue(new Error('db down'));
    const result = await connectRecallWhatsapp(prisma, PARAMS);
    expect(result.ok).toBe(true);
  });
});
