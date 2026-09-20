// =============================================================================
// Chatbot — el tope de mensajes al mes (lib/chatbot-usage.ts y
// lib/chatbot-settings.ts).
//
// Lo que de verdad se prueba: que al llegar al tope NO se incrementa nada y
// se niega, que el mes nuevo reinicia solo, que cada chatbot tiene su propio
// contador, y que un fallo del contador deja pasar el mensaje en vez de
// dejar mudo al bot de alguien que paga.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotSettings: {
      findUnique: (...args: unknown[]) => mockState.settingsFindUnique(...args),
      upsert: vi.fn(),
    },
  },
}));

import { consumeMessageAllowance, readMessageUsage } from '@/lib/chatbot-usage';
import { capForTier, DEFAULT_MESSAGE_CAPS } from '@/lib/chatbot-settings';

const NOW = new Date('2026-09-20T10:00:00.000Z');
const MES_ANTERIOR = new Date('2026-08-31T23:00:00.000Z');

function makePrisma(row: Record<string, unknown> | null) {
  const usage = {
    findUnique: vi.fn().mockResolvedValue(row),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({ messagesThisMonth: ((row?.messagesThisMonth as number) ?? 0) + 1 }),
  };
  return { prisma: { chatbotUsage: usage } as never, usage };
}

const input = { clientProductId: 'cp_a', clientId: 'c1', tenantId: 't1', tier: 'starter' };

beforeEach(() => {
  mockState.settingsFindUnique.mockReset().mockResolvedValue(null);
});

describe('capForTier', () => {
  it('cada tarifa tiene el suyo', () => {
    expect(capForTier('starter', DEFAULT_MESSAGE_CAPS)).toBe(DEFAULT_MESSAGE_CAPS.starter);
    expect(capForTier('pro', DEFAULT_MESSAGE_CAPS)).toBe(DEFAULT_MESSAGE_CAPS.pro);
    expect(capForTier('PREMIUM', DEFAULT_MESSAGE_CAPS)).toBe(DEFAULT_MESSAGE_CAPS.premium);
  });

  it('una tarifa desconocida cae en la más baja, no en la más alta', () => {
    expect(capForTier('enterprise', DEFAULT_MESSAGE_CAPS)).toBe(DEFAULT_MESSAGE_CAPS.starter);
    expect(capForTier(null, DEFAULT_MESSAGE_CAPS)).toBe(DEFAULT_MESSAGE_CAPS.starter);
  });
});

describe('consumeMessageAllowance', () => {
  it('el primer mensaje del chatbot crea su contador', async () => {
    const { prisma, usage } = makePrisma(null);
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({
      allowed: true,
      used: 1,
      cap: DEFAULT_MESSAGE_CAPS.starter,
    });
    expect(usage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientProductId: 'cp_a', messagesThisMonth: 1, usageResetAt: NOW }),
      }),
    );
  });

  it('dentro del tope, suma uno', async () => {
    const { prisma, usage } = makePrisma({ id: 'u1', messagesThisMonth: 5, usageResetAt: NOW, capOverride: null });
    const res = await consumeMessageAllowance(prisma, input, NOW);
    expect(res.allowed).toBe(true);
    expect(usage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { messagesThisMonth: { increment: 1 } } }),
    );
  });

  it('en el tope, niega y NO incrementa', async () => {
    const { prisma, usage } = makePrisma({
      id: 'u1',
      messagesThisMonth: DEFAULT_MESSAGE_CAPS.starter,
      usageResetAt: NOW,
      capOverride: null,
    });
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({
      allowed: false,
      used: DEFAULT_MESSAGE_CAPS.starter,
      cap: DEFAULT_MESSAGE_CAPS.starter,
    });
    expect(usage.update).not.toHaveBeenCalled();
  });

  it('un mes nuevo reinicia el contador sin cron', async () => {
    const { prisma, usage } = makePrisma({
      id: 'u1',
      messagesThisMonth: 99999,
      usageResetAt: MES_ANTERIOR,
      capOverride: null,
    });
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({
      allowed: true,
      used: 1,
      cap: DEFAULT_MESSAGE_CAPS.starter,
    });
    expect(usage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { messagesThisMonth: 1, usageResetAt: NOW } }),
    );
  });

  it('el contador es de ESTE chatbot, no del cliente', async () => {
    const { prisma, usage } = makePrisma(null);
    await consumeMessageAllowance(prisma, { ...input, clientProductId: 'cp_b' }, NOW);
    expect(usage.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { clientProductId: 'cp_b' } }));
  });

  it('el tope del operador manda sobre el de la tarifa', async () => {
    const { prisma } = makePrisma({ id: 'u1', messagesThisMonth: 10, usageResetAt: NOW, capOverride: 10 });
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({ allowed: false, used: 10, cap: 10 });
  });

  it('usa los topes que el operador guardó, no los del código', async () => {
    mockState.settingsFindUnique.mockResolvedValue({
      monthlyMessageCapStarter: 7,
      monthlyMessageCapPro: 8,
      monthlyMessageCapPremium: 9,
    });
    const { prisma } = makePrisma({ id: 'u1', messagesThisMonth: 7, usageResetAt: NOW, capOverride: null });
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({ allowed: false, used: 7, cap: 7 });
  });

  it('si el contador falla, el mensaje pasa: un fallo nuestro no deja mudo al bot', async () => {
    const prisma = {
      chatbotUsage: { findUnique: vi.fn().mockRejectedValue(new Error('boom')) },
    } as never;
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(consumeMessageAllowance(prisma, input, NOW)).resolves.toEqual({ allowed: true, used: 0, cap: 0 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('readMessageUsage', () => {
  it('sin fila, cero gastado', async () => {
    const { prisma } = makePrisma(null);
    await expect(readMessageUsage(prisma, 'cp_a', 'pro', NOW)).resolves.toEqual({
      used: 0,
      cap: DEFAULT_MESSAGE_CAPS.pro,
    });
  });

  it('una fila del mes pasado cuenta como cero, sin escribir nada', async () => {
    const { prisma, usage } = makePrisma({ messagesThisMonth: 500, usageResetAt: MES_ANTERIOR, capOverride: null });
    await expect(readMessageUsage(prisma, 'cp_a', 'starter', NOW)).resolves.toEqual({
      used: 0,
      cap: DEFAULT_MESSAGE_CAPS.starter,
    });
    expect(usage.update).not.toHaveBeenCalled();
  });
});
