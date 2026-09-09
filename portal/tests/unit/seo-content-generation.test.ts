// =============================================================================
// SEO con IA, Fase C — unit tests for src/lib/seo-content-generation.ts.
//
// Cubre: la cadencia (minIntervalDays es un parámetro; resolverlo desde los
// ajustes del operador es cosa de seo-settings.test.ts), la construcción de
// señales a partir del último audit y de Search Console, y —desde la Fase
// 1.3, en la que la redacción pasó de un workflow de n8n inexistente al
// propio portal— qué se guarda cuando el artículo sale bien y qué NO se
// toca cuando sale mal.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  generateArticleDraft: vi.fn(),
  getContentGenerationMinIntervalDays: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/seo-content-ai', () => ({
  generateArticleDraft: (...args: unknown[]) => mockState.generateArticleDraft(...args),
}));

vi.mock('@/lib/seo-settings', () => ({
  getContentGenerationMinIntervalDays: (...args: unknown[]) => mockState.getContentGenerationMinIntervalDays(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isGenerationDue, sweepDueProfiles } from '@/lib/seo-content-generation';

const ARTICLE = {
  ok: true as const,
  title: 'Cómo elegir un candado de alta seguridad',
  metaDescription: 'Qué mirar antes de comprar un candado, explicado sin tecnicismos.',
  targetKeyword: 'candado alta seguridad',
  bodyHtml: '<h2>Qué mirar</h2><p>Lo primero es el arco.</p>',
};

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    businessDescription: 'Ferretería de barrio con más de 20 años de historia.',
    targetAudience: 'Vecinos y pequeños talleres.',
    toneOfVoice: 'Cercano y directo.',
    siteUrl: 'https://ferreteriacentral.example',
    lastAuditResult: { title: 'Ferretería Central', h1Count: 1 },
    lastContentRequestedAt: null,
    contentGenerationMinIntervalDaysOverride: null,
    client: { companyName: 'Ferretería Central', name: 'Paco' },
    ...overrides,
  };
}

function makePrisma(profiles: ReturnType<typeof baseProfile>[]) {
  const seoProfileUpdate = vi.fn().mockResolvedValue({});
  const seoContentDraftCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: `draft_for_${data.profileId}`, ...data }),
  );
  const googleSeoConnectionFindUnique = vi.fn().mockResolvedValue(null);
  const seoSearchConsoleMetricFindMany = vi.fn().mockResolvedValue([]);
  const seoSearchConsoleQueryFindMany = vi.fn().mockResolvedValue([]);

  return {
    seoProfile: {
      findMany: vi.fn().mockResolvedValue(profiles),
      update: seoProfileUpdate,
    },
    seoContentDraft: { create: seoContentDraftCreate },
    googleSeoConnection: { findUnique: googleSeoConnectionFindUnique },
    seoSearchConsoleMetric: { findMany: seoSearchConsoleMetricFindMany },
    seoSearchConsoleQuery: { findMany: seoSearchConsoleQueryFindMany },
    __mocks: {
      seoProfileUpdate,
      seoContentDraftCreate,
      googleSeoConnectionFindUnique,
      seoSearchConsoleMetricFindMany,
      seoSearchConsoleQueryFindMany,
    },
  } as never;
}

function mocksOf(prisma: unknown) {
  return (prisma as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
}

beforeEach(() => {
  mockState.generateArticleDraft.mockReset().mockResolvedValue(ARTICLE);
  mockState.getContentGenerationMinIntervalDays.mockReset().mockResolvedValue(3);
  mockState.logError.mockReset();
});

describe('isGenerationDue', () => {
  it('is due when there is no prior request', () => {
    expect(isGenerationDue(null, 3)).toBe(true);
  });

  it('is NOT due within the given interval', () => {
    expect(isGenerationDue(new Date(Date.now() - 1 * 24 * 60 * 60_000), 3)).toBe(false);
  });

  it('is due once the given interval has elapsed', () => {
    expect(isGenerationDue(new Date(Date.now() - 8 * 24 * 60 * 60_000), 7)).toBe(true);
  });
});

describe('sweepDueProfiles — cadencia', () => {
  it('solo procesa los perfiles que tocan', async () => {
    const prisma = makePrisma([
      baseProfile({ id: 'due_1', lastContentRequestedAt: null }),
      baseProfile({ id: 'not_due', lastContentRequestedAt: new Date() }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ due: 1, processed: 1, generated: 1, failed: 0, skipped: 0 });
    expect(mocksOf(prisma).seoContentDraftCreate).toHaveBeenCalledTimes(1);
  });

  it('resuelve el intervalo configurado por el operador', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(10);
    const prisma = makePrisma([
      baseProfile({ id: 'not_due_at_10', lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000) }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ due: 0, processed: 0, generated: 0, failed: 0, skipped: 0 });
    expect(mockState.getContentGenerationMinIntervalDays).toHaveBeenCalledTimes(1);
  });

  it('el override del propio perfil gana al valor global', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(10);
    const prisma = makePrisma([
      baseProfile({
        id: 'overridden',
        lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        contentGenerationMinIntervalDaysOverride: 3,
      }),
    ]);
    expect(await sweepDueProfiles(prisma)).toMatchObject({ generated: 1 });
  });

  it('sin override (NULL) usa el global, no "siempre toca"', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(30);
    const prisma = makePrisma([
      baseProfile({
        id: 'no_override',
        lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        contentGenerationMinIntervalDaysOverride: null,
      }),
    ]);
    expect(await sweepDueProfiles(prisma)).toMatchObject({ due: 0, generated: 0 });
  });

  it('reparte entre ticks en vez de agotar el minuto del cron', async () => {
    const prisma = makePrisma([
      baseProfile({ id: 'p1' }), baseProfile({ id: 'p2' }), baseProfile({ id: 'p3' }), baseProfile({ id: 'p4' }),
    ]);
    const result = await sweepDueProfiles(prisma);
    // Los 4 tocan, pero solo se escriben 2: el resto sigue vencido y entra
    // en el siguiente barrido.
    expect(result).toMatchObject({ due: 4, processed: 2, generated: 2 });
    expect(mockState.generateArticleDraft).toHaveBeenCalledTimes(2);
  });
});

describe('sweepDueProfiles — señales que recibe el redactor', () => {
  it('le pasa el contexto del negocio y su nombre', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    expect(mockState.generateArticleDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: 'Ferretería Central',
        businessDescription: 'Ferretería de barrio con más de 20 años de historia.',
        targetAudience: 'Vecinos y pequeños talleres.',
        toneOfVoice: 'Cercano y directo.',
        siteUrl: 'https://ferreteriacentral.example',
        siteAudit: { title: 'Ferretería Central', h1Count: 1 },
      }),
    );
  });

  it('cae al nombre de contacto si el cliente no tiene nombre comercial', async () => {
    const prisma = makePrisma([baseProfile({ client: { companyName: null, name: 'Paco' } })]);
    await sweepDueProfiles(prisma);
    expect(mockState.generateArticleDraft).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Paco' }));
  });

  it('sin conexión activa de Search Console, no hay oportunidades que pasar', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    expect(mockState.generateArticleDraft).toHaveBeenCalledWith(
      expect.objectContaining({ queryOpportunities: [] }),
    );
    expect(mocksOf(prisma).seoSearchConsoleQueryFindMany).not.toHaveBeenCalled();
  });

  it('pasa las consultas en posición 4-20 ordenadas por impresiones', async () => {
    const prisma = makePrisma([baseProfile()]);
    const { googleSeoConnectionFindUnique, seoSearchConsoleQueryFindMany } = mocksOf(prisma);
    googleSeoConnectionFindUnique.mockResolvedValueOnce({ id: 'conn_1', status: 'active' });
    seoSearchConsoleQueryFindMany.mockResolvedValueOnce([
      { query: 'cerrajero urgente', impressions: 120, clicks: 3, position: 9.42 },
      { query: 'candado alta seguridad', impressions: 80, clicks: 1, position: 14.07 },
    ]);

    await sweepDueProfiles(prisma);

    expect(seoSearchConsoleQueryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId: 'conn_1', position: { gte: 4, lte: 20 } },
        orderBy: { impressions: 'desc' },
        take: 15,
      }),
    );
    expect(mockState.generateArticleDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        queryOpportunities: [
          { query: 'cerrajero urgente', impressions: 120, clicks: 3, position: 9.4 },
          { query: 'candado alta seguridad', impressions: 80, clicks: 1, position: 14.1 },
        ],
      }),
    );
  });
});

describe('sweepDueProfiles — qué queda guardado', () => {
  it('guarda el artículo ya en estado revisable por el operador', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);

    expect(mocksOf(prisma).seoContentDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileId: 'profile_1',
          clientId: 'client_1',
          status: 'drafted',
          title: ARTICLE.title,
          bodyHtml: ARTICLE.bodyHtml,
          targetKeyword: ARTICLE.targetKeyword,
          metaDescription: ARTICLE.metaDescription,
          generatedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('conserva las señales con las que se escribió, para el contexto del revisor', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    const { data } = mocksOf(prisma).seoContentDraftCreate.mock.calls[0][0];
    expect(data.sourceSignals).toMatchObject({ siteAudit: { title: 'Ferretería Central' } });
  });

  it('avanza la cadencia solo cuando hay artículo', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    expect(mocksOf(prisma).seoProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'profile_1' }, data: { lastContentRequestedAt: expect.any(Date) } }),
    );
  });

  it('guarda vacíos como null, no como cadena vacía', async () => {
    mockState.generateArticleDraft.mockResolvedValue({ ...ARTICLE, targetKeyword: '', metaDescription: '' });
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    const { data } = mocksOf(prisma).seoContentDraftCreate.mock.calls[0][0];
    expect(data.targetKeyword).toBeNull();
    expect(data.metaDescription).toBeNull();
  });
});

describe('sweepDueProfiles — cuando el redactor falla', () => {
  it('no crea borrador ni avanza la cadencia: el siguiente barrido reintenta', async () => {
    mockState.generateArticleDraft.mockResolvedValue({ ok: false, error: 'anthropic_api_error:529' });
    const prisma = makePrisma([baseProfile()]);

    const result = await sweepDueProfiles(prisma);

    expect(result).toEqual({ due: 1, processed: 1, generated: 0, failed: 1, skipped: 0 });
    expect(mocksOf(prisma).seoContentDraftCreate).not.toHaveBeenCalled();
    expect(mocksOf(prisma).seoProfileUpdate).not.toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalledWith(
      'seo_content_generation.generation_failed',
      expect.any(Error),
      expect.anything(),
      'warn',
    );
  });

  it('sin clave de IA tampoco quema la cadencia del mes', async () => {
    mockState.generateArticleDraft.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const prisma = makePrisma([baseProfile()]);

    const result = await sweepDueProfiles(prisma);

    expect(result).toEqual({ due: 1, processed: 1, generated: 0, failed: 0, skipped: 1 });
    expect(mocksOf(prisma).seoContentDraftCreate).not.toHaveBeenCalled();
    expect(mocksOf(prisma).seoProfileUpdate).not.toHaveBeenCalled();
  });

  it('un perfil que falla no impide que se escriba el del siguiente cliente', async () => {
    mockState.generateArticleDraft
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
      .mockResolvedValueOnce(ARTICLE);
    const prisma = makePrisma([baseProfile({ id: 'p1' }), baseProfile({ id: 'p2' })]);

    const result = await sweepDueProfiles(prisma);

    expect(result).toMatchObject({ generated: 1, failed: 1 });
  });
});
