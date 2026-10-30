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
//
// 30/10/2026 — guardar y escribir son dos pasos: createPublicDraft guarda la
// petición sin llamar al modelo, y generatePublicDraft la escribe después
// (la ruta, tras contestar; si falla, el barrido de public-draft-delivery.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  generate: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/web-draft-ai', () => ({ generateWebDraftCopy: (...a: unknown[]) => mockState.generate(...a) }));
vi.mock('@/lib/web-draft-design', () => ({ designForDraft: vi.fn(async () => null) }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  createPublicDraft,
  generatePublicDraft,
  hashIp,
  MAX_GENERATION_ATTEMPTS,
  PUBLIC_SECTORS,
  MAX_DRAFTS_PER_DAY_GLOBAL,
  MAX_DRAFTS_PER_IP_PER_DAY,
} from '@/lib/public-draft-request';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  publicDraftRequest: {
    count: (...a: unknown[]) => mockState.count(...a),
    create: (...a: unknown[]) => mockState.create(...a),
    updateMany: (...a: unknown[]) => mockState.updateMany(...a),
    update: (...a: unknown[]) => mockState.update(...a),
    findUnique: (...a: unknown[]) => mockState.findUnique(...a),
    findUniqueOrThrow: (...a: unknown[]) => mockState.findUniqueOrThrow(...a),
  },
} as unknown as PrismaClient;

const COPY = { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' };
const INPUT = {
  businessName: 'Fontanería Ejemplo',
  city: 'Elche',
  email: 'hola@fontaneriaejemplo.es',
  phone: null,
  sector: 'fontaneria',
  ip: '88.1.2.3',
};

beforeEach(() => {
  mockState.generate.mockReset().mockResolvedValue({ ok: true, copy: COPY, model: 'claude-sonnet-5' });
  mockState.count.mockReset().mockResolvedValue(0);
  mockState.create.mockReset().mockResolvedValue({ id: 'req-1' });
  mockState.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockState.update.mockReset().mockResolvedValue({});
  mockState.findUnique.mockReset().mockResolvedValue(null);
  mockState.findUniqueOrThrow.mockReset().mockResolvedValue({
    businessName: 'Fontanería Ejemplo',
    primaryType: 'plumber',
    city: 'Elche',
    themeKey: 'trades-1',
  });
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
  it('guarda la petición y devuelve su testigo, sin llamar al modelo', async () => {
    const result = await createPublicDraft(prisma, INPUT);
    expect(result).toMatchObject({ ok: true, id: 'req-1' });
    if (result.ok) expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockState.create).toHaveBeenCalled();
    expect(mockState.create.mock.calls[0][0].data.copy).toBeUndefined();
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('el contacto es el correo; el teléfono, si lo deja, va aparte', async () => {
    await createPublicDraft(prisma, { ...INPUT, phone: '600112233' });
    expect(mockState.create.mock.calls[0][0].data).toMatchObject({ contact: 'hola@fontaneriaejemplo.es', phone: '600112233' });
    // El formulario antiguo, con solo teléfono: se guarda como antes.
    await createPublicDraft(prisma, { ...INPUT, email: null, phone: '600112233' });
    expect(mockState.create.mock.calls[1][0].data).toMatchObject({ contact: '600112233', phone: null });
  });

  // 20/10/2026 — el contacto es para hablar de SU borrador; escribirle con
  // ofertas exige la casilla marcada (art. 21 LSSI).
  it('el consentimiento comercial solo se guarda si la casilla viene marcada', async () => {
    await createPublicDraft(prisma, INPUT);
    await createPublicDraft(prisma, { ...INPUT, marketingConsent: true });
    expect(mockState.create.mock.calls[0][0].data.marketingConsentAt).toBeNull();
    expect(mockState.create.mock.calls[1][0].data.marketingConsentAt).toBeInstanceOf(Date);
  });

  it('el campo trampa se mira ANTES de gastar una consulta', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, website: 'http://spam.example' });
    expect(result).toEqual({ ok: false, error: 'invalid' });
    expect(mockState.count).not.toHaveBeenCalled();
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('sin contacto no hay borrador: es el precio de verlo', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, email: '  ', phone: null });
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

  it('un sector desconocido no rompe: cae al genérico', async () => {
    const result = await createPublicDraft(prisma, { ...INPUT, sector: 'astronauta' });
    expect(result.ok).toBe(true);
    expect(mockState.create.mock.calls[0][0].data.primaryType).toBe(PUBLIC_SECTORS.otro.primaryType);
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

describe('generatePublicDraft', () => {
  it('reserva un intento ANTES de llamar al modelo y guarda lo escrito', async () => {
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('generated');
    const claim = mockState.updateMany.mock.calls[0][0];
    expect(claim.where.generationAttempts).toEqual({ lt: MAX_GENERATION_ATTEMPTS });
    expect(claim.data).toEqual({ generationAttempts: { increment: 1 } });
    expect(mockState.generate.mock.calls[0][0]).toMatchObject({ businessName: 'Fontanería Ejemplo', city: 'Elche' });
    expect(mockState.update.mock.calls[0][0].data).toMatchObject({ copy: COPY, model: 'claude-sonnet-5' });
  });

  it('si ya está escrito, o se agotaron los intentos, no llama al modelo', async () => {
    mockState.updateMany.mockResolvedValue({ count: 0 });
    mockState.findUnique.mockResolvedValueOnce({ model: 'claude-sonnet-5' }).mockResolvedValueOnce({ model: null });
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('already');
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('gave_up');
    expect(mockState.generate).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo del modelo (o sin clave) deja la fila sin escribir para reintentarla', async () => {
    mockState.generate.mockResolvedValueOnce({ ok: false, error: 'overloaded' });
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('failed');
    mockState.generate.mockResolvedValueOnce({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('failed');
    mockState.generate.mockRejectedValueOnce(new Error('red'));
    expect(await generatePublicDraft(prisma, 'req-1')).toBe('failed');
    expect(mockState.update).not.toHaveBeenCalled();
  });
});
