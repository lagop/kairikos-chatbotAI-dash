// =============================================================================
// 05/10/2026 — «Pedir reseña» de una llamada (requestReviewForCall).
//
// Es lo que da reseñas a Llamadas Esencial, que no lleva resumen del día. Lo
// que no puede pasar: pedir reseña desde la llamada de otro cliente, pedirla
// dos veces al mismo número, escribir a quien pidió la baja, o a un número
// oculto.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  createCampaignWithRequests: vi.fn(),
  isNumberBlocked: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-api')>('@/lib/whatsapp-api');
  return { ...actual, sendTemplate: vi.fn() };
});
vi.mock('@/lib/recall-messaging', () => ({ metaSenderFor: () => ({ token: 't', phoneNumberId: 'p' }) }));
vi.mock('@/lib/recall-blocklist', () => ({ isNumberBlocked: (...a: unknown[]) => mockState.isNumberBlocked(...a) }));
vi.mock('@/lib/review-request-campaign', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/review-request-campaign')>('@/lib/review-request-campaign');
  return { ...actual, createCampaignWithRequests: (...a: unknown[]) => mockState.createCampaignWithRequests(...a) };
});

import { requestReviewForCall, reviewRequestedAtByNumber, REVIEW_REQUEST_COOLDOWN_DAYS } from '@/lib/recall-reviews';

const NOW = new Date('2026-10-05T10:00:00Z');
const CALL = {
  id: 'call_1',
  subscriptionId: 'sub_1',
  fromNumber: '+34600111222',
  withheld: false,
  subscription: { status: 'active', googleConnectionId: 'g1' },
};

function makePrisma(opts: { call?: unknown; previous?: unknown } = {}) {
  return {
    callEvent: {
      findFirst: vi.fn().mockResolvedValue(opts.call === undefined ? CALL : opts.call),
      findMany: vi.fn().mockResolvedValue([{ fromNumber: CALL.fromNumber }]),
    },
    reviewRequest: {
      findFirst: vi.fn().mockResolvedValue(opts.previous ?? null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    recallSubscription: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'sub_1',
        clientId: 'c1',
        googleConnectionId: 'g1',
        googleConnection: { id: 'g1', clientId: 'c1' },
        metaConnection: { id: 'm1' },
        client: { name: 'Aurora', companyName: 'Fontanería Aurora' },
      }),
    },
  };
}

beforeEach(() => {
  mockState.createCampaignWithRequests.mockReset().mockResolvedValue({ ok: true, campaignId: 'camp_1' });
  mockState.isNumberBlocked.mockReset().mockResolvedValue(false);
});

describe('requestReviewForCall', () => {
  it('manda la invitación por WhatsApp al número de esa llamada', async () => {
    const prisma = makePrisma();
    await expect(requestReviewForCall(prisma as never, { clientId: 'c1', callEventId: 'call_1' }, NOW)).resolves.toBe('sent');
    expect(prisma.callEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'call_1', clientId: 'c1' } }),
    );
    expect(mockState.createCampaignWithRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        recipients: [{ recipient: '+34600111222', name: null }],
        consentBasis: 'customer_relationship',
      }),
    );
  });

  it('la llamada de otro cliente no se encuentra', async () => {
    const prisma = makePrisma({ call: null });
    await expect(requestReviewForCall(prisma as never, { clientId: 'c1', callEventId: 'ajena' }, NOW)).resolves.toBe('not_found');
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('no se pide dos veces al mismo número en el periodo de espera', async () => {
    const prisma = makePrisma({ previous: { id: 'rr_0' } });
    await expect(requestReviewForCall(prisma as never, { clientId: 'c1', callEventId: 'call_1' }, NOW)).resolves.toBe(
      'already_requested',
    );
    expect(prisma.reviewRequest.findFirst).toHaveBeenCalledWith({
      where: {
        recipient: '+34600111222',
        createdAt: { gte: new Date(NOW.getTime() - REVIEW_REQUEST_COOLDOWN_DAYS * 24 * 60 * 60 * 1000) },
        campaign: { clientId: 'c1' },
      },
      select: { id: true },
    });
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('nunca a un número bloqueado o que pidió la baja', async () => {
    mockState.isNumberBlocked.mockResolvedValue(true);
    await expect(requestReviewForCall(makePrisma() as never, { clientId: 'c1', callEventId: 'call_1' }, NOW)).resolves.toBe(
      'blocked',
    );
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('número oculto, sin ficha de Google o línea no activa: no hay envío', async () => {
    await expect(
      requestReviewForCall(makePrisma({ call: { ...CALL, withheld: true, fromNumber: null } }) as never, { clientId: 'c1', callEventId: 'call_1' }, NOW),
    ).resolves.toBe('no_number');
    await expect(
      requestReviewForCall(
        makePrisma({ call: { ...CALL, subscription: { status: 'active', googleConnectionId: null } } }) as never,
        { clientId: 'c1', callEventId: 'call_1' },
        NOW,
      ),
    ).resolves.toBe('no_google');
    await expect(
      requestReviewForCall(
        makePrisma({ call: { ...CALL, subscription: { status: 'paused', googleConnectionId: 'g1' } } }) as never,
        { clientId: 'c1', callEventId: 'call_1' },
        NOW,
      ),
    ).resolves.toBe('not_found');
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('si el envío falla, lo dice', async () => {
    mockState.createCampaignWithRequests.mockResolvedValue({ ok: false, error: 'no_review_url' });
    await expect(requestReviewForCall(makePrisma() as never, { clientId: 'c1', callEventId: 'call_1' }, NOW)).resolves.toBe(
      'failed',
    );
  });
});

describe('reviewRequestedAtByNumber', () => {
  it('el más reciente por número, solo de este cliente', async () => {
    const prisma = makePrisma();
    prisma.reviewRequest.findMany.mockResolvedValue([
      { recipient: '+34600111222', createdAt: new Date('2026-10-04T10:00:00Z') },
      { recipient: '+34600111222', createdAt: new Date('2026-09-01T10:00:00Z') },
    ]);
    const map = await reviewRequestedAtByNumber(prisma as never, 'c1', ['+34600111222', ' +34600111222 '], NOW);
    expect(map.get('+34600111222')).toEqual(new Date('2026-10-04T10:00:00Z'));
    expect(prisma.reviewRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ recipient: { in: ['+34600111222'] }, campaign: { clientId: 'c1' } }) }),
    );
  });
});
