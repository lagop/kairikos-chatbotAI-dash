// =============================================================================
// Fase 3.3 — unit tests para src/lib/prospecting-replies.ts.
//
// Lo que se fija aquí es el emparejamiento de teléfonos, que es donde este
// módulo se rompe en silencio: si no casa, la secuencia sigue escribiendo a
// alguien que ya contestó (el fallo caro); si casa de más, se deja de
// escribir a quien no ha dicho nada (el fallo silencioso). Y que nunca
// lance, porque cuelga de la ruta que responde al prospecto.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  phoneDigits,
  phonesMatch,
  markProspectReplied,
  MIN_PHONE_MATCH_DIGITS,
  REPLY_ATTRIBUTION_MAX_AGE_DAYS,
} from '@/lib/prospecting-replies';

const NOW = new Date('2026-09-15T10:00:00.000Z');

const state = {
  leadFindMany: vi.fn(),
  leadUpdate: vi.fn(),
  leadAuditCreate: vi.fn(),
};

const mockTx = {
  lead: { update: (...a: unknown[]) => state.leadUpdate(...a) },
  leadAudit: { create: (...a: unknown[]) => state.leadAuditCreate(...a) },
};

const prisma = {
  $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  lead: { findMany: (...a: unknown[]) => state.leadFindMany(...a) },
} as unknown as PrismaClient;

function lead(over: Record<string, unknown> = {}) {
  return { id: 'lead_1', tenantId: 't1', contactPhone: '+34 928 12 34 56', status: 'contactado', ...over };
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.logError.mockReset();
  state.leadFindMany.mockResolvedValue([]);
  state.leadUpdate.mockResolvedValue({});
  state.leadAuditCreate.mockResolvedValue({});
});

describe('phoneDigits', () => {
  it('deja solo dígitos, que es lo único común entre Places y Meta', () => {
    expect(phoneDigits('+34 928 12 34 56')).toBe('34928123456');
    expect(phoneDigits('34928123456')).toBe('34928123456');
    expect(phoneDigits(null)).toBe('');
  });
});

describe('phonesMatch', () => {
  it('casa el formato internacional de Places con el wa_id crudo de Meta', () => {
    expect(phonesMatch('+34 928 12 34 56', '34928123456')).toBe(true);
  });

  it('casa un número guardado en formato nacional con uno que trae prefijo de país', () => {
    expect(phonesMatch('928123456', '34928123456')).toBe(true);
  });

  it('no casa dos números distintos', () => {
    expect(phonesMatch('+34928123456', '+34928999999')).toBe(false);
  });

  it('se niega a comparar cuando hay muy pocos dígitos — una coincidencia corta no prueba nada', () => {
    expect(phonesMatch('123456', '34999123456')).toBe(false);
    expect(MIN_PHONE_MATCH_DIGITS).toBe(9);
  });

  it('un teléfono ausente nunca casa', () => {
    expect(phonesMatch(null, '34928123456')).toBe(false);
    expect(phonesMatch('34928123456', '')).toBe(false);
  });
});

describe('markProspectReplied', () => {
  it('estampa repliedAt y audita cuando el teléfono entrante es de un prospecto', async () => {
    state.leadFindMany.mockResolvedValue([lead()]);

    const result = await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });

    expect(result).toEqual({ matched: 1 });
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { repliedAt: NOW } });
    expect(state.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ leadId: 'lead_1', action: 'replied', actorId: 'system:prospecting' }),
      }),
    );
  });

  it('no cambia el estado del lead: responder no es comprar', async () => {
    state.leadFindMany.mockResolvedValue([lead({ status: 'contactado' })]);
    await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { repliedAt: NOW } });
    const audit = state.leadAuditCreate.mock.calls[0][0].data;
    expect(audit.statusBefore).toBe('contactado');
    expect(audit.statusAfter).toBe('contactado');
  });

  it('marca los dos leads cuando dos locales comparten teléfono', async () => {
    state.leadFindMany.mockResolvedValue([lead({ id: 'lead_1' }), lead({ id: 'lead_2' })]);
    const result = await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });
    expect(result).toEqual({ matched: 2 });
    expect(state.leadUpdate).toHaveBeenCalledTimes(2);
  });

  it('un mensaje de alguien que no es prospecto no toca nada', async () => {
    state.leadFindMany.mockResolvedValue([lead({ contactPhone: '+34928999999' })]);
    const result = await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });
    expect(result).toEqual({ matched: 0 });
    expect(state.leadUpdate).not.toHaveBeenCalled();
  });

  it('busca solo entre los outbound sin responder y contactados hace poco', async () => {
    await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });
    const where = state.leadFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ clientId: 'c1', source: 'outbound', repliedAt: null });
    expect(where.contactedAt.gte).toEqual(
      new Date(NOW.getTime() - REPLY_ATTRIBUTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
    );
  });

  it('ni consulta cuando el remitente trae demasiados pocos dígitos', async () => {
    const result = await markProspectReplied(prisma, { clientId: 'c1', phone: '1234', now: NOW });
    expect(result).toEqual({ matched: 0 });
    expect(state.leadFindMany).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de base de datos no puede tumbar la respuesta al prospecto', async () => {
    state.leadFindMany.mockRejectedValue(new Error('db down'));
    const result = await markProspectReplied(prisma, { clientId: 'c1', phone: '34928123456', now: NOW });
    expect(result).toEqual({ matched: 0 });
    expect(mockState.logError).toHaveBeenCalledWith(
      'prospecting_replies.mark_failed',
      expect.any(Error),
      expect.objectContaining({ clientId: 'c1' }),
      'warn',
    );
  });
});
