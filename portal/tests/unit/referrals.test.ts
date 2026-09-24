// =============================================================================
// A7 — unit tests de los códigos de referido y de socio.
//
// Lo que se fija:
//
// 1. Que la atribución sea de una vez y gane el PRIMERO. Si alguien llega con
//    el código de un distribuidor y tres meses después pone el de un amigo,
//    quien lo trajo fue el distribuidor. Sin esta regla, la comisión se la
//    lleva el último que pasó por ahí.
// 2. Que nadie se recomiende a sí mismo para ganarse un mes gratis.
// 3. Que la comisión se calcule sobre el MRR ACTIVO: si el cliente se da de
//    baja, la comisión se acaba. Es lo que hace que al socio le interese
//    traer clientes que se queden.
// 4. Que el código sea tecleable: lo imprime un almacén en un cartel y lo lee
//    gente con prisa, así que nada de O/0 ni I/1.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findCode: vi.fn(),
  findAttribution: vi.fn(),
  createAttribution: vi.fn(),
}));

import { attributeClient, computeCommissions, generateReferralCode, normalizeCode } from '@/lib/referrals';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  referralCode: { findUnique: (...a: unknown[]) => mockState.findCode(...a) },
  referralAttribution: {
    findUnique: (...a: unknown[]) => mockState.findAttribution(...a),
    create: (...a: unknown[]) => mockState.createAttribution(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  mockState.findCode.mockReset().mockResolvedValue({
    id: 'code-1',
    code: 'SALTOKI-ADEF2',
    kind: 'partner',
    active: true,
    referrerClientId: null,
  });
  mockState.findAttribution.mockReset().mockResolvedValue(null);
  mockState.createAttribution.mockReset().mockResolvedValue({});
});

describe('normalizeCode', () => {
  it('un código tecleado con prisa se reconoce igual', () => {
    expect(normalizeCode(' saltoki-adef2 ')).toBe('SALTOKI-ADEF2');
    expect(normalizeCode('saltoki adef2')).toBe('SALTOKIADEF2');
  });
});

describe('generateReferralCode', () => {
  it('no usa caracteres que se confunden al leer un cartel', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode('SALTOKI').split('-')[1];
      expect(code).not.toMatch(/[O0I1B8SZ]/);
    }
  });

  it('lleva delante el prefijo del socio, para reconocerlo de un vistazo', () => {
    expect(generateReferralCode('Saltoki')).toMatch(/^SALTOKI-/);
  });
});

describe('attributeClient', () => {
  it('apunta de quién vino el cliente', async () => {
    const result = await attributeClient(prisma, 'client-1', 'saltoki-adef2');
    expect(result).toEqual({ ok: true, codeId: 'code-1' });
    expect(mockState.createAttribution).toHaveBeenCalled();
  });

  it('un código desconocido no atribuye nada', async () => {
    mockState.findCode.mockResolvedValue(null);
    expect(await attributeClient(prisma, 'client-1', 'NOEXISTE')).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('un código desactivado tampoco', async () => {
    mockState.findCode.mockResolvedValue({ id: 'c', code: 'X', kind: 'partner', active: false, referrerClientId: null });
    expect(await attributeClient(prisma, 'client-1', 'X')).toEqual({ ok: false, reason: 'inactive_code' });
  });

  it('gana el primero: el segundo código no pisa al que lo trajo', async () => {
    mockState.findAttribution.mockResolvedValue({ id: 'a1', codeId: 'otro' });
    expect(await attributeClient(prisma, 'client-1', 'SALTOKI-ADEF2')).toEqual({
      ok: false,
      reason: 'already_attributed',
    });
    expect(mockState.createAttribution).not.toHaveBeenCalled();
  });

  it('nadie se recomienda a sí mismo', async () => {
    mockState.findCode.mockResolvedValue({
      id: 'c',
      code: 'X',
      kind: 'referral',
      active: true,
      referrerClientId: 'client-1',
    });
    expect(await attributeClient(prisma, 'client-1', 'X')).toEqual({ ok: false, reason: 'self_referral' });
  });
});

describe('computeCommissions', () => {
  it('la comisión sale del MRR de los clientes que trajo', () => {
    const rows = computeCommissions([
      {
        code: 'SALTOKI-ADEF2',
        kind: 'partner',
        partnerName: 'Almacenes Saltoki',
        referrerName: null,
        commissionPercent: 20,
        clientMrrCents: [14900, 24900],
      },
    ]);
    expect(rows[0]).toMatchObject({
      clientesTraidos: 2,
      mrrTraidoCents: 39800,
      comisionMensualCents: 7960,
    });
  });

  it('un cliente que se fue deja de contar: su MRR ya no está en la lista', () => {
    const rows = computeCommissions([
      {
        code: 'X',
        kind: 'partner',
        partnerName: 'Socio',
        referrerName: null,
        commissionPercent: 20,
        clientMrrCents: [],
      },
    ]);
    expect(rows[0].comisionMensualCents).toBe(0);
  });

  it('los referidos no cobran dinero: su premio es un mes gratis', () => {
    const rows = computeCommissions([
      {
        code: 'ANA-X',
        kind: 'referral',
        partnerName: null,
        referrerName: 'Fontanería Ana',
        commissionPercent: null,
        clientMrrCents: [14900],
      },
    ]);
    expect(rows[0].comisionMensualCents).toBe(0);
    expect(rows[0].clientesTraidos).toBe(1);
  });

  it('ordena por lo que hay que pagar, que es para lo que se mira', () => {
    const rows = computeCommissions([
      { code: 'A', kind: 'partner', partnerName: 'A', referrerName: null, commissionPercent: 20, clientMrrCents: [10000] },
      { code: 'B', kind: 'partner', partnerName: 'B', referrerName: null, commissionPercent: 20, clientMrrCents: [50000] },
    ]);
    expect(rows[0].code).toBe('B');
  });
});
