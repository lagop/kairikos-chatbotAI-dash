// =============================================================================
// A11, capa 3 — unit tests del formulario público de kairikos.com.
//
// Esta es la superficie más peligrosa del producto: cada pulsación gasta
// dinero nuestro (~2 céntimos de Sonnet) y no hay nadie identificado al otro
// lado. Lo que se fija aquí son los cuatro frenos, en orden de lo que paran:
//
//   1. Tope GLOBAL del día — el único que acota el gasto pase lo que pase.
//   2. Tope por IP y día — para el goteo de un curioso.
//   3. Contacto obligatorio — fricción, no verificación.
//   4. Campo trampa — y que se mire ANTES de gastar una sola consulta.
//
// Y una cosa más: que el modelo no se llame nunca si alguno salta.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  generate: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/web-draft-ai', () => ({ generateWebDraftCopy: (...a: unknown[]) => mockState.generate(...a) }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  createPublicDraft,
  hashIp,
  PUBLIC_SECTORS,
  MAX_DRAFTS_PER_DAY_GLOBAL,
  MAX_DRAFTS_PER_IP_PER_DAY,
} from '@/lib/public-draft-request';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  publicDraftRequest: {
    count: (...a: unknown[]) => mockState.count(...a),
    create: (...a: unknown[]) => mockState.create(...a),
  },
} as unknown as PrismaClient;

const COPY = { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' };
const INPUT = {
  businessName: 'Fontanería Ejemplo',
  city: 'Elche',
  contact: '600112233',
  sector: 'fontaneria',
  ip: '88.1.2.3',
};

beforeEach(() => {
  mockState.generate.mockReset().mockResolvedValue({ ok: true, copy: COPY, model: 'claude-sonnet-5' });
  mockState.count.mockReset().mockResolvedValue(0);
  mockState.create.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
});

describe('hashIp', () => {
  it('la IP no se guarda en claro', () => {
    const hash = hashIp('88.1.2.3');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('88.1.2.3');
  });

  it('la misma IP da el mismo hash, que es lo que permite contar', () => {
    expect(hashIp('88.1.2.3')).toBe(hashIp('88.1.2.3'));
    expect(hashIp('88.1.2.3')).not.toBe(hashIp('88.1.2.4'));
  });
});

describe('createPublicDraft', () => {
  it('genera el borrador y devuelve su testigo', async () => {
    const result = await createPublicDraft(prisma, INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockState.create).toHaveBeenCalled();
  });

  it('el campo trampa se mira ANTES de gastar una consulta', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, website: 'http://spam.example' });
    expect(result).toEqual({ ok: false, error: 'invalid' });
    expect(mockState.count).not.toHaveBeenCalled();
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('sin contacto no hay borrador: es el precio de verlo', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, contact: '' });
    expect(result).toEqual({ ok: false, error: 'invalid' });
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('el tope global corta aunque la IP sea nueva', async () => {
    mockState.count.mockImplementation(async (args: { where: { ipHash?: string } }) =>
      args.where.ipHash ? 0 : MAX_DRAFTS_PER_DAY_GLOBAL,
    );
    const result = await createPublicDraft(prisma, INPUT);
    expect(result).toEqual({ ok: false, error: 'rate_limited_global' });
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('el tope por IP corta aunque quede cupo global', async () => {
    mockState.count.mockImplementation(async (args: { where: { ipHash?: string } }) =>
      args.where.ipHash ? MAX_DRAFTS_PER_IP_PER_DAY : 0,
    );
    const result = await createPublicDraft(prisma, INPUT);
    expect(result).toEqual({ ok: false, error: 'rate_limited_ip' });
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('sin clave de Anthropic no se guarda una fila vacía', async () => {
    mockState.generate.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const result = await createPublicDraft(prisma, INPUT);
    expect(result).toEqual({ ok: false, error: 'unavailable' });
    expect(mockState.create).not.toHaveBeenCalled();
  });

  it('un sector desconocido no rompe: cae al genérico', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, sector: 'astronauta' });
    expect(result.ok).toBe(true);
    expect(mockState.generate.mock.calls[0][0].primaryType).toBe(PUBLIC_SECTORS.otro.primaryType);
  });

  it('cada sector de la lista tiene su categoría de Google', () => {
    for (const [clave, sector] of Object.entries(PUBLIC_SECTORS)) {
      expect(sector.primaryType, `sector ${clave}`).toBeTruthy();
      expect(sector.label, `sector ${clave}`).toBeTruthy();
    }
  });

  it('lo que escribe el visitante se recorta antes de guardarlo', async () => {
    await createPublicDraft(prisma, { ...INPUT, businessName: 'x'.repeat(500) });
    expect(mockState.create.mock.calls[0][0].data.businessName.length).toBe(200);
  });
});
