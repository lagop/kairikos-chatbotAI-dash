// =============================================================================
// A11, capa 2 — unit tests del barrido de borradores.
//
// Lo que se fija aquí es sobre todo dinero: cada borrador son ~1,8 céntimos
// de Sonnet, y un barrido sin frenos que encuentre 500 prospectos generaría
// 500 borradores que nadie va a enseñar. Los frenos son el tope DIARIO (no
// por ejecución: el tick corre cada 5 minutos), no regenerar lo ya hecho, y
// no gastar en quien ya tiene web propia.
//
// Y la regla de plantilla: dos negocios del mismo rubro y la misma zona no
// pueden recibir la misma web, porque se conocen y se enseñan las cosas.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  generate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/web-draft-ai', () => ({
  generateWebDraftCopy: (...args: unknown[]) => mockState.generate(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { sweepPendingWebDrafts, pickVariant, DAILY_DRAFT_CAP } from '@/lib/web-draft-sweep';
import { VARIANTS_PER_THEME } from '@/lib/web-draft-html';
import type { PrismaClient } from '@prisma/client';

const COPY = { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' };

function lead(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? 'lead-1',
    clientId: 'client-1',
    tenantId: null,
    contactName: over.contactName ?? 'Fontanería Ejemplo',
    contactPhone: '+34600000000',
    website: over.website ?? null,
    summary: null,
    primaryType: over.primaryType ?? 'plumber',
    searchCategory: 'fontanero',
    searchLocation: over.searchLocation ?? 'Elche',
    ...over,
  };
}

function fakePrisma(opts: { leads?: unknown[]; generatedToday?: number; siblings?: { themeKey: string }[] } = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    prospectingWebDraft: {
      count: vi.fn().mockResolvedValue(opts.generatedToday ?? 0),
      findMany: vi.fn().mockResolvedValue(opts.siblings ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    lead: { findMany: vi.fn().mockResolvedValue(opts.leads ?? []) },
  } as unknown as PrismaClient;
  return { prisma, created };
}

beforeEach(() => {
  mockState.generate.mockReset().mockResolvedValue({ ok: true, copy: COPY, model: 'claude-sonnet-5' });
  mockState.logError.mockReset();
});

describe('pickVariant', () => {
  it('con la zona libre usa la primera variante', () => {
    expect(pickVariant('beauty', [], 0)).toBe('beauty-1');
  });

  it('no repite la variante de un competidor del mismo rubro y zona', () => {
    expect(pickVariant('beauty', ['beauty-1'], 1)).toBe('beauty-2');
    expect(pickVariant('beauty', ['beauty-1', 'beauty-2'], 2)).toBe('beauty-3');
  });

  it('con todas usadas rota en vez de fallar: mejor repetir que no tener borrador', () => {
    // Escrito contra VARIANTS_PER_THEME y no contra un número fijo: la
    // constante ya subió de 3 a 8 cuando el primer barrido real repitió
    // variante, y volverá a moverse.
    const todas = Array.from({ length: VARIANTS_PER_THEME }, (_, i) => `beauty-${i + 1}`);
    expect(todas).toContain(pickVariant('beauty', todas, VARIANTS_PER_THEME));
  });

  it('con ocho variantes hacen falta nueve negocios del mismo rubro y zona para repetir', () => {
    const usadas: string[] = [];
    for (let i = 0; i < VARIANTS_PER_THEME; i += 1) {
      usadas.push(pickVariant('beauty', [...usadas], i));
    }
    expect(new Set(usadas).size).toBe(VARIANTS_PER_THEME);
  });
});

describe('sweepPendingWebDrafts', () => {
  it('no gasta en quien ya tiene web propia', async () => {
    const { prisma, created } = fakePrisma({
      leads: [
        lead({ id: 'a', contactName: 'Fontanería Martínez', website: 'https://fontaneriamartinez.es' }),
        lead({ id: 'b', contactName: 'Bar Pepe', website: 'https://directorio.example/bares/gc/bar-pepe' }),
        lead({ id: 'c', contactName: 'Sin Web SL', website: null }),
      ],
    });
    const result = await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(result.generated).toBe(2);
    expect(created.map((d) => d.leadId)).toEqual(['b', 'c']);
  });

  it('respeta el tope diario contando lo ya generado hoy', async () => {
    const { prisma, created } = fakePrisma({
      leads: Array.from({ length: 10 }, (_, i) => lead({ id: `l${i}` })),
      generatedToday: DAILY_DRAFT_CAP - 2,
    });
    const result = await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(created).toHaveLength(2);
    expect(result.generated).toBe(2);
  });

  it('con el tope agotado no llama al modelo ni una vez', async () => {
    const { prisma } = fakePrisma({ leads: [lead()], generatedToday: DAILY_DRAFT_CAP });
    const result = await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(result.capReached).toBe(true);
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('sin clave configurada corta el lote en vez de intentarlo con todos', async () => {
    mockState.generate.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const { prisma, created } = fakePrisma({ leads: [lead({ id: 'a' }), lead({ id: 'b' })] });
    const result = await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(mockState.generate).toHaveBeenCalledTimes(1);
    expect(result.skippedNoApiKey).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('un fallo del modelo no arrastra al resto del lote', async () => {
    mockState.generate
      .mockResolvedValueOnce({ ok: false, error: 'anthropic_api_error:500' })
      .mockResolvedValue({ ok: true, copy: COPY, model: 'claude-sonnet-5' });
    const { prisma, created } = fakePrisma({ leads: [lead({ id: 'a' }), lead({ id: 'b' })] });
    const result = await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(result.failed).toBe(1);
    expect(result.generated).toBe(1);
    expect(created).toHaveLength(1);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('cada borrador nace con su enlace público', async () => {
    const { prisma, created } = fakePrisma({ leads: [lead()] });
    await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(created[0].shareToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('elige variante mirando a los competidores de su zona', async () => {
    const { prisma, created } = fakePrisma({
      leads: [lead({ primaryType: 'hair_salon', searchLocation: 'Las Palmas' })],
      siblings: [{ themeKey: 'beauty-1' }],
    });
    await sweepPendingWebDrafts(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(created[0].themeKey).toBe('beauty-2');
  });
});
