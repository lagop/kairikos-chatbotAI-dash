// =============================================================================
// "Sistema IA de captación" — unit tests for lib/lead-classification-sweep.ts.
// Same mocking shape as prospecting-tick-route.test.ts: mock the Prisma
// surface + the collaborator modules, assert the due-query, the per-client
// monthly cap, and that one conversation failing never costs the others
// their turn.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  conversationFindMany: vi.fn(),
  conversationUpdate: vi.fn(),
  profileFindUnique: vi.fn(),
  profileUpdate: vi.fn(),
  profileCreate: vi.fn(),
  clientProductFindFirst: vi.fn(),
  chatbotClientFindUnique: vi.fn(),
  leadFindMany: vi.fn(),
  classifyConversationForLead: vi.fn(),
  ingestClassifiedLead: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/lead-classification-ai', () => ({
  classifyConversationForLead: (...a: unknown[]) => mockState.classifyConversationForLead(...a),
}));

vi.mock('@/lib/leads', () => ({
  ingestClassifiedLead: (...a: unknown[]) => mockState.ingestClassifiedLead(...a),
  LEADS_CLASSIFICATION_MONTHLY_CAP: 500,
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const prismaMock = {
  lead: { findMany: (...a: unknown[]) => mockState.leadFindMany(...a) },
  chatbotConversation: {
    findMany: (...a: unknown[]) => mockState.conversationFindMany(...a),
    update: (...a: unknown[]) => mockState.conversationUpdate(...a),
  },
  leadQualificationProfile: {
    findUnique: (...a: unknown[]) => mockState.profileFindUnique(...a),
    update: (...a: unknown[]) => mockState.profileUpdate(...a),
    create: (...a: unknown[]) => mockState.profileCreate(...a),
  },
  clientProduct: {
    findFirst: (...a: unknown[]) => mockState.clientProductFindFirst(...a),
  },
  chatbotClient: {
    findUnique: (...a: unknown[]) => mockState.chatbotClientFindUnique(...a),
  },
} as unknown as Parameters<typeof import('@/lib/lead-classification-sweep').sweepDueConversationsForClassification>[0];

const CONVERSATION = {
  id: 'conv_1',
  clientId: 'client_1',
  tenantId: null,
  outcome: 'resolved',
  transcript: [{ role: 'user', content: 'quiero presupuesto' }],
};

beforeEach(() => {
  mockState.conversationFindMany.mockReset().mockResolvedValue([CONVERSATION]);
  mockState.conversationUpdate.mockReset().mockResolvedValue({});
  mockState.profileFindUnique.mockReset().mockResolvedValue({
    classificationsThisMonth: 0,
    usageResetAt: new Date(),
  });
  mockState.profileUpdate.mockReset().mockResolvedValue({ classificationsThisMonth: 0 });
  mockState.profileCreate.mockReset().mockResolvedValue({ classificationsThisMonth: 0 });
  mockState.clientProductFindFirst.mockReset().mockResolvedValue({ id: 'cp_1', tenantId: null });
  mockState.chatbotClientFindUnique.mockReset().mockResolvedValue({ name: 'Owner', companyName: 'Negocio' });
  mockState.leadFindMany.mockReset().mockResolvedValue([]);
  mockState.classifyConversationForLead.mockReset().mockResolvedValue({
    ok: true,
    isLead: false,
    score: 0,
    scoreReason: 'sin interés',
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    summary: null,
  });
  mockState.ingestClassifiedLead.mockReset().mockResolvedValue({ leadId: 'lead_1', created: true });
  mockState.logError.mockReset();
});

async function sweep() {
  const { sweepDueConversationsForClassification } = await import('@/lib/lead-classification-sweep');
  return sweepDueConversationsForClassification(prismaMock);
}

describe('sweepDueConversationsForClassification', () => {
  it('busca las no clasificadas de clientes con leads: cerradas O empezadas hace rato', async () => {
    await sweep();
    expect(mockState.conversationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leadsClassifiedAt: null,
          client: { clientProducts: { some: { status: 'active', product: { code: 'leads' } } } },
        }),
      }),
    );
  });

  // El agujero que esto cierra: el motor solo pone outcome al derivar a una
  // persona, así que la mayoría de las conversaciones no se cerraban nunca y
  // su lead no llegaba a existir. Ver la cabecera del lib.
  it('una conversación sin cerrar entra igual si empezó hace más de dos horas', async () => {
    await sweep();
    const where = mockState.conversationFindMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ outcome: { not: null } });
    const limite = where.OR[1].startedAt.lt as Date;
    const horas = (Date.now() - limite.getTime()) / 3_600_000;
    const { CONVERSATION_STALE_HOURS } = await import('@/lib/lead-classification-sweep');
    expect(horas).toBeGreaterThanOrEqual(CONVERSATION_STALE_HOURS - 0.01);
    expect(horas).toBeLessThan(CONVERSATION_STALE_HOURS + 0.5);
  });

  it('classifies a due conversation and marks leadsClassifiedAt, without creating a lead when isLead is false', async () => {
    const result = await sweep();
    expect(result).toEqual({ swept: 1, classified: 1, leadsCreated: 0, capped: 0 });
    expect(mockState.ingestClassifiedLead).not.toHaveBeenCalled();
    expect(mockState.conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv_1' }, data: expect.objectContaining({ leadsClassifiedAt: expect.any(Date) }) }),
    );
  });

  it('creates a Lead via ingestClassifiedLead when isLead is true', async () => {
    mockState.classifyConversationForLead.mockResolvedValue({
      ok: true,
      isLead: true,
      score: 85,
      scoreReason: 'quiere presupuesto y da su teléfono',
      contactName: 'Jordi Pla',
      contactPhone: '622334455',
      contactEmail: null,
      summary: 'Quiere reformar el local',
    });
    const result = await sweep();
    expect(result.leadsCreated).toBe(1);
    expect(mockState.ingestClassifiedLead).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        conversation: { id: 'conv_1', clientId: 'client_1', tenantId: null },
        contactName: 'Jordi Pla',
        contactPhone: '622334455',
        score: 85,
        actorId: 'system:classifier',
      }),
    );
  });

  // Fase 1.5 — el canal ya viaja en la conversación, así que el lead deja
  // de salir "sin canal".
  it('propaga el canal de la conversación al lead', async () => {
    mockState.conversationFindMany.mockResolvedValue([{ ...CONVERSATION, channel: 'instagram' }]);
    mockState.classifyConversationForLead.mockResolvedValue({
      ok: true, isLead: true, score: 70, scoreReason: 'pide precio',
      contactName: null, contactPhone: null, contactEmail: null, summary: 'quiere cita',
    });

    await sweep();

    expect(mockState.ingestClassifiedLead).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ channel: 'instagram' }),
    );
  });

  it('increments the monthly classification count on every real classifier call, whether or not it found a lead', async () => {
    await sweep();
    expect(mockState.profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client_1' }, data: { classificationsThisMonth: { increment: 1 } } }),
    );
  });

  it('skips (no API key) without marking leadsClassifiedAt or incrementing the cap', async () => {
    mockState.classifyConversationForLead.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const result = await sweep();
    expect(result).toEqual({ swept: 1, classified: 0, leadsCreated: 0, capped: 0 });
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    expect(mockState.profileUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { classificationsThisMonth: { increment: 1 } } }),
    );
  });

  it('skips a client already at the monthly cap without marking leadsClassifiedAt — retried after reset', async () => {
    mockState.profileFindUnique.mockResolvedValue({ classificationsThisMonth: 500, usageResetAt: new Date() });
    const result = await sweep();
    expect(result).toEqual({ swept: 1, classified: 0, leadsCreated: 0, capped: 1 });
    expect(mockState.classifyConversationForLead).not.toHaveBeenCalled();
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
  });

  it('resets the cap on a new UTC calendar month before checking it', async () => {
    mockState.profileFindUnique.mockResolvedValue({
      classificationsThisMonth: 500,
      usageResetAt: new Date('2026-01-01T00:00:00Z'),
    });
    mockState.profileUpdate.mockResolvedValueOnce({ classificationsThisMonth: 0 }).mockResolvedValueOnce({});
    const result = await sweep();
    expect(result.capped).toBe(0);
    expect(mockState.classifyConversationForLead).toHaveBeenCalled();
  });

  it('lazily creates the qualification profile for a client that never touched their card', async () => {
    mockState.profileFindUnique.mockResolvedValue(null);
    await sweep();
    expect(mockState.profileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: 'client_1', clientProductId: 'cp_1' }),
      }),
    );
  });

  it('one conversation throwing does not stop the others from being classified', async () => {
    mockState.conversationFindMany.mockResolvedValue([CONVERSATION, { ...CONVERSATION, id: 'conv_2', clientId: 'client_2' }]);
    mockState.chatbotClientFindUnique
      .mockResolvedValueOnce({ name: 'Owner', companyName: 'Negocio' })
      .mockRejectedValueOnce(new Error('db down'));
    const result = await sweep();
    expect(result.swept).toBe(2);
    expect(mockState.logError).toHaveBeenCalled();
  });

  // Fase 2.3 — el bucle de aprendizaje.
  it('le pasa al clasificador los leads que el cliente ya cerró', async () => {
    mockState.leadFindMany
      .mockResolvedValueOnce([{ summary: 'Firmó la reforma' }])
      .mockResolvedValueOnce([{ summary: 'Buscaba empleo' }]);

    await sweep();

    expect(mockState.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'convertido' }) }),
    );
    expect(mockState.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'descartado' }) }),
    );
    expect(mockState.classifyConversationForLead).toHaveBeenCalledWith(
      expect.objectContaining({
        examples: [
          { summary: 'Firmó la reforma', converted: true },
          { summary: 'Buscaba empleo', converted: false },
        ],
      }),
    );
  });

  it('un cliente sin histórico se clasifica igual, con la lista vacía', async () => {
    await sweep();
    expect(mockState.classifyConversationForLead).toHaveBeenCalledWith(
      expect.objectContaining({ examples: [] }),
    );
  });

  it('passes the qualification profile fields into the classifier prompt input', async () => {
    // Both the cap-check read and the qualification-fields read go through
    // the same mocked findUnique here, so the mock's return value carries
    // more fields than a real narrowed `select` would — this only asserts
    // the two fields the classifier prompt actually reads are present.
    mockState.profileFindUnique.mockResolvedValue({
      classificationsThisMonth: 0,
      usageResetAt: new Date(),
      perfilClienteIdeal: 'dueños de local con presupuesto',
      senalesDescarte: 'busca empleo',
    });
    await sweep();
    expect(mockState.classifyConversationForLead).toHaveBeenCalledWith(
      expect.objectContaining({
        qualification: expect.objectContaining({
          perfilClienteIdeal: 'dueños de local con presupuesto',
          senalesDescarte: 'busca empleo',
        }),
      }),
    );
  });
});
