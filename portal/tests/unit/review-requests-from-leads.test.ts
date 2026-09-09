// =============================================================================
// Fase 5 — unit tests for lib/review-requests-from-leads.ts.
//
// Same mocking shape as lead-classification-sweep.test.ts: mock the Prisma
// surface plus the collaborator modules, then assert the things that would
// fail silently in production — the freshness window in the due-query, the
// cross-campaign cooldown, and exactly WHICH leads get stamped, which is
// what decides whether a customer is invited twice or never.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  leadFindMany: vi.fn(),
  leadUpdateMany: vi.fn(),
  reviewRequestFindMany: vi.fn(),
  chatbotClientFindUnique: vi.fn(),
  isProductContracted: vi.fn(),
  hasLeadsInboxAccess: vi.fn(),
  createCampaignWithRequests: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/review-request-campaign', () => ({
  createCampaignWithRequests: (...a: unknown[]) => mockState.createCampaignWithRequests(...a),
  // La de verdad, no un mock: es la que decide si una dirección es
  // utilizable, y falsearla dejaría pickRecipient sin probar.
  isAddressable: (channel: string, recipient: string) =>
    channel === 'email' ? recipient.includes('@') : /^\+?\d{6,}$/.test(recipient),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...a: unknown[]) => mockState.isProductContracted(...a),
}));

vi.mock('@/lib/leads', () => ({
  hasLeadsInboxAccess: (...a: unknown[]) => mockState.hasLeadsInboxAccess(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const prismaMock = {
  googleBusinessConnection: { findMany: (...a: unknown[]) => mockState.connectionFindMany(...a) },
  lead: {
    findMany: (...a: unknown[]) => mockState.leadFindMany(...a),
    updateMany: (...a: unknown[]) => mockState.leadUpdateMany(...a),
  },
  reviewRequest: { findMany: (...a: unknown[]) => mockState.reviewRequestFindMany(...a) },
  chatbotClient: { findUnique: (...a: unknown[]) => mockState.chatbotClientFindUnique(...a) },
} as never;

const CONNECTION = {
  id: 'conn_1',
  clientId: 'client_1',
  tenantId: 'tenant_1',
  locationName: 'Bar Paco',
  status: 'active',
  autoRequestFromLeads: true,
};

const NOW = new Date('2026-09-22T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockState.connectionFindMany.mockResolvedValue([CONNECTION]);
  mockState.isProductContracted.mockResolvedValue(true);
  mockState.hasLeadsInboxAccess.mockResolvedValue(true);
  mockState.reviewRequestFindMany.mockResolvedValue([]);
  mockState.leadUpdateMany.mockResolvedValue({ count: 0 });
  mockState.chatbotClientFindUnique.mockResolvedValue({ name: 'Paco', companyName: 'Bar Paco SL' });
  mockState.createCampaignWithRequests.mockResolvedValue({
    ok: true,
    campaignId: 'camp_1',
    sent: 1,
    failed: 0,
    skipped: 0,
  });
  mockState.leadFindMany.mockResolvedValue([]);
});

async function sweep(now = NOW) {
  const { sweepReviewRequestsFromLeads } = await import('@/lib/review-requests-from-leads');
  return sweepReviewRequestsFromLeads(prismaMock, { now });
}

describe('pickRecipient', () => {
  it('normalises the address and keeps a trimmed name', async () => {
    const { pickRecipient } = await import('@/lib/review-requests-from-leads');
    expect(pickRecipient({ id: 'l1', contactName: '  Ana  ', contactEmail: '  Ana@Bar.ES ' })).toEqual({
      recipient: 'ana@bar.es',
      name: 'Ana',
    });
  });

  it('returns null when there is no usable address', async () => {
    const { pickRecipient } = await import('@/lib/review-requests-from-leads');
    expect(pickRecipient({ id: 'l1', contactName: 'Ana', contactEmail: null })).toBeNull();
    expect(pickRecipient({ id: 'l2', contactName: 'Ana', contactEmail: '   ' })).toBeNull();
    // Un teléfono es una dirección real, pero no en este canal. Que no se
    // cuele como si fuera un correo es justo lo que evita un envío a la
    // nada registrado como enviado.
    expect(pickRecipient({ id: 'l3', contactName: null, contactEmail: '+34600111222' })).toBeNull();
  });

  it('leaves the name null rather than empty', async () => {
    const { pickRecipient } = await import('@/lib/review-requests-from-leads');
    expect(pickRecipient({ id: 'l1', contactName: '   ', contactEmail: 'a@b.es' })).toEqual({
      recipient: 'a@b.es',
      name: null,
    });
  });
});

describe('sweepReviewRequestsFromLeads', () => {
  it('only asks for converted, unstamped leads inside the freshness window', async () => {
    await sweep();
    const where = mockState.leadFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('convertido');
    expect(where.reviewRequestedAt).toBeNull();
    // Siete días exactos hacia atrás desde `now`.
    expect(where.convertedAt.gte).toEqual(new Date('2026-09-15T10:00:00.000Z'));
  });

  it('invites the converted leads and stamps exactly those', async () => {
    mockState.leadFindMany.mockResolvedValue([
      { id: 'lead_1', contactName: 'Ana', contactEmail: 'ana@bar.es' },
      { id: 'lead_2', contactName: null, contactEmail: 'luis@bar.es' },
    ]);

    const result = await sweep();

    expect(result.invited).toBe(2);
    expect(result.campaignsCreated).toBe(1);
    const campaign = mockState.createCampaignWithRequests.mock.calls[0][0];
    expect(campaign.channel).toBe('email');
    expect(campaign.consentBasis).toBe('customer_relationship');
    expect(campaign.businessName).toBe('Bar Paco SL');
    expect(campaign.recipients).toEqual([
      { recipient: 'ana@bar.es', name: 'Ana' },
      { recipient: 'luis@bar.es', name: null },
    ]);
    expect(mockState.leadUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead_1', 'lead_2'] } },
      data: { reviewRequestedAt: NOW },
    });
  });

  it('stamps a lead with no usable address instead of retrying it forever', async () => {
    mockState.leadFindMany.mockResolvedValue([{ id: 'lead_1', contactName: 'Ana', contactEmail: null }]);

    const result = await sweep();

    expect(result.skippedNoAddress).toBe(1);
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
    expect(mockState.leadUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead_1'] } },
      data: { reviewRequestedAt: NOW },
    });
  });

  it('does not invite someone already invited by ANY campaign of this client', async () => {
    mockState.leadFindMany.mockResolvedValue([
      { id: 'lead_1', contactName: 'Ana', contactEmail: 'ana@bar.es' },
      { id: 'lead_2', contactName: 'Luis', contactEmail: 'luis@bar.es' },
    ]);
    // Ana ya recibió una — da igual si fue de la lista que el dueño pegó
    // a mano o de un barrido anterior.
    mockState.reviewRequestFindMany.mockResolvedValue([{ recipient: 'ana@bar.es' }]);

    const result = await sweep();

    expect(result.skippedCooldown).toBe(1);
    expect(result.invited).toBe(1);
    expect(mockState.createCampaignWithRequests.mock.calls[0][0].recipients).toEqual([
      { recipient: 'luis@bar.es', name: 'Luis' },
    ]);
    // La consulta del periodo de gracia no se limita a las campañas
    // automáticas: mira las del cliente entero.
    const cooldownWhere = mockState.reviewRequestFindMany.mock.calls[0][0].where;
    expect(cooldownWhere.campaign).toEqual({ clientId: 'client_1' });
    expect(cooldownWhere.createdAt.gte).toEqual(new Date('2025-09-22T10:00:00.000Z'));
    // Ana se sella igual: la decisión de no invitarla ya está tomada.
    expect(mockState.leadUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead_2'] } },
      data: { reviewRequestedAt: NOW },
    });
  });

  it('does NOT stamp when the campaign could not be created', async () => {
    mockState.leadFindMany.mockResolvedValue([{ id: 'lead_1', contactName: 'Ana', contactEmail: 'ana@bar.es' }]);
    mockState.createCampaignWithRequests.mockResolvedValue({ ok: false, error: 'no_review_url' });

    const result = await sweep();

    expect(result.invited).toBe(0);
    // Sin sellar vuelve al siguiente tick; sellado se habría perdido para
    // siempre por un fallo que no era suyo.
    expect(mockState.leadUpdateMany).not.toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('does nothing for a client whose products no longer cover it', async () => {
    mockState.leadFindMany.mockResolvedValue([{ id: 'lead_1', contactName: 'Ana', contactEmail: 'ana@bar.es' }]);
    // El interruptor vive en la conexión y sobrevive a la baja del
    // producto, así que la comprobación tiene que ser aquí, no al
    // activarlo.
    mockState.isProductContracted.mockResolvedValue(false);

    const result = await sweep();

    expect(result.invited).toBe(0);
    expect(mockState.leadFindMany).not.toHaveBeenCalled();
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('needs the leads inbox too, not just reviews', async () => {
    mockState.hasLeadsInboxAccess.mockResolvedValue(false);
    const result = await sweep();
    expect(result.invited).toBe(0);
    expect(mockState.leadFindMany).not.toHaveBeenCalled();
  });

  it('isolates a failing connection from the rest', async () => {
    mockState.connectionFindMany.mockResolvedValue([
      { ...CONNECTION, id: 'conn_1', clientId: 'client_1' },
      { ...CONNECTION, id: 'conn_2', clientId: 'client_2' },
    ]);
    mockState.leadFindMany
      .mockRejectedValueOnce(new Error('db exploded'))
      .mockResolvedValueOnce([{ id: 'lead_9', contactName: 'Eva', contactEmail: 'eva@bar.es' }]);

    const result = await sweep();

    expect(result.failed).toEqual([{ clientId: 'client_1', error: 'db exploded' }]);
    expect(result.invited).toBe(1);
    expect(result.connectionsScanned).toBe(2);
  });

  it('asks for the oldest connection first so two locations cannot double-invite', async () => {
    await sweep();
    expect(mockState.connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { autoRequestFromLeads: true, status: 'active' },
        orderBy: { connectedAt: 'asc' },
      }),
    );
  });
});
