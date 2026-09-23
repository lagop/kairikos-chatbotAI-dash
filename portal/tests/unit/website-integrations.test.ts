// =============================================================================
// Producto Web, Fase 1 — unit tests de lo que la web publicada toma de los
// otros productos del cliente.
//
// Dos reglas que se fijan aquí:
//
// 1. Nada aparece sin el producto contratado. Ni estrellas de alguien que no
//    paga `reviews`, ni un número de `recall` que no controla.
// 2. Con `recall`, el teléfono de la web ES el de recall. Dejar el viejo hace
//    que el producto recién comprado no recoja ninguna llamada de su propia
//    web, y es un fallo que no da ningún error — solo silencio.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  isContracted: vi.fn(),
  findReviews: vi.fn(),
  findRecall: vi.fn(),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...a: unknown[]) => mockState.isContracted(...a),
}));

import { resolveWebsiteIntegrations } from '@/lib/website-integrations';
import { buildWebsiteFiles } from '@/lib/website-build';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  googleReview: { findMany: (...a: unknown[]) => mockState.findReviews(...a) },
  recallSubscription: { findFirst: (...a: unknown[]) => mockState.findRecall(...a) },
} as unknown as PrismaClient;

const NOW = new Date('2026-09-24T10:00:00Z');

function review(stars: number) {
  return { starRating: stars, createTime: new Date('2026-09-01T10:00:00Z'), replyComment: null };
}

beforeEach(() => {
  // Por defecto, todo contratado: cada test apaga lo que quiere comprobar.
  // Con un helper que se consulta dos veces, mockResolvedValueOnce miente
  // — la lección de CLAUDE.md sobre hasGoogleBusinessConnectAccess.
  mockState.isContracted.mockReset().mockResolvedValue(true);
  mockState.findReviews.mockReset().mockResolvedValue([review(5), review(4), review(5)]);
  mockState.findRecall.mockReset().mockResolvedValue({ virtualNumber: { e164: '+34910000000' } });
});

describe('resolveWebsiteIntegrations', () => {
  it('con los dos productos, trae estrellas y número', async () => {
    const result = await resolveWebsiteIntegrations(prisma, 'client-1', NOW);
    expect(result.reviews).toEqual({ rating: 4.7, count: 3 });
    expect(result.recallPhone).toBe('+34910000000');
  });

  it('sin reviews contratado no se enseñan estrellas, aunque las haya en la base', async () => {
    mockState.isContracted.mockImplementation(async (_p: unknown, _c: unknown, code: string) => code !== 'reviews');
    const result = await resolveWebsiteIntegrations(prisma, 'client-1', NOW);
    expect(result.reviews).toBeNull();
    expect(mockState.findReviews).not.toHaveBeenCalled();
  });

  it('sin recall contratado no se le cambia el teléfono', async () => {
    mockState.isContracted.mockImplementation(async (_p: unknown, _c: unknown, code: string) => code !== 'recall');
    const result = await resolveWebsiteIntegrations(prisma, 'client-1', NOW);
    expect(result.recallPhone).toBeNull();
  });

  it('con menos de tres reseñas no se enseña nada: "4,0 · 1 reseña" resta', async () => {
    mockState.findReviews.mockResolvedValue([review(4), review(5)]);
    const result = await resolveWebsiteIntegrations(prisma, 'client-1', NOW);
    expect(result.reviews).toBeNull();
  });

  it('con recall contratado pero sin número asignado todavía, no se inventa uno', async () => {
    mockState.findRecall.mockResolvedValue({ virtualNumber: null });
    const result = await resolveWebsiteIntegrations(prisma, 'client-1', NOW);
    expect(result.recallPhone).toBeNull();
  });
});

describe('buildWebsiteFiles con integraciones', () => {
  const base = {
    businessName: 'Fontanería Ejemplo',
    primaryType: 'plumber',
    themeKey: 'trades-1',
    phone: '+34600112233',
    address: 'Calle Mayor 1',
    city: 'Elche',
    copy: { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' },
    generatedAt: NOW,
  };

  it('el teléfono de la web pasa a ser el de recall', async () => {
    const files = await buildWebsiteFiles({
      ...base,
      integrations: { reviews: null, recallPhone: '+34910000000' },
    });
    const html = files[0].content.toString('utf8');
    expect(html).toContain('910 00 00 00');
    expect(html).not.toContain('600 11 22 33');
  });

  it('sin integraciones se queda su teléfono de siempre', async () => {
    const files = await buildWebsiteFiles({ ...base, integrations: null });
    const html = files[0].content.toString('utf8');
    expect(html).toContain('600 11 22 33');
  });

  it('las estrellas solo salen cuando vienen de reviews', async () => {
    const sin = await buildWebsiteFiles({ ...base, integrations: null });
    expect(sin[0].content.toString('utf8')).not.toContain('reseñas en Google');

    const con = await buildWebsiteFiles({
      ...base,
      integrations: { reviews: { rating: 4.7, count: 128 }, recallPhone: null },
    });
    const html = con[0].content.toString('utf8');
    expect(html).toContain('reseñas en Google');
    expect(html).toContain('4.7');
  });
});
