// =============================================================================
// 15/11/2026 — el operador activa idiomas para quien llama a un cliente.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setCallerLanguages } from '@/lib/recall-caller-language-settings';

const state = {
  findUnique: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findUnique: (...a: unknown[]) => state.findUnique(...a),
    update: (...a: unknown[]) => state.update(...a),
  },
  recallSubscriptionAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
} as unknown as PrismaClient;

const actor = { operatorId: 'op_1', email: 'op@kairikos.example' };

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.findUnique.mockResolvedValue({ id: 'sub_1', clientId: 'client_1', callerLanguages: ['es'] });
  state.update.mockResolvedValue({ id: 'sub_1' });
  state.auditCreate.mockResolvedValue({});
});

describe('setCallerLanguages', () => {
  it('guarda los idiomas en orden fijo, con el español siempre, y lo deja auditado', async () => {
    const result = await setCallerLanguages(prisma, { subscriptionId: 'sub_1', languages: ['de'], actor });
    expect(result).toEqual({ ok: true, callerLanguages: ['es', 'de'], changed: true });
    expect(state.update.mock.calls[0][0]).toMatchObject({ where: { id: 'sub_1' }, data: { callerLanguages: ['es', 'de'] } });
    expect(state.auditCreate.mock.calls[0][0].data).toMatchObject({
      subscriptionId: 'sub_1',
      clientId: 'client_1',
      action: 'caller_languages_changed',
      before: { callerLanguages: ['es'] },
      after: { callerLanguages: ['es', 'de'] },
      actorType: 'operator',
      actorOperatorId: 'op_1',
    });
  });

  it('sin cambios no escribe nada', async () => {
    state.findUnique.mockResolvedValue({ id: 'sub_1', clientId: 'client_1', callerLanguages: ['es', 'de'] });
    const result = await setCallerLanguages(prisma, { subscriptionId: 'sub_1', languages: ['de', 'es'], actor });
    expect(result).toEqual({ ok: true, callerLanguages: ['es', 'de'], changed: false });
    expect(state.update).not.toHaveBeenCalled();
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('un idioma que no existe es un error, no se ignora en silencio', async () => {
    const result = await setCallerLanguages(prisma, { subscriptionId: 'sub_1', languages: ['es', 'fr'], actor });
    expect(result).toEqual({ ok: false, error: 'invalid_language' });
    expect(state.findUnique).not.toHaveBeenCalled();
  });

  it('suscripción inexistente', async () => {
    state.findUnique.mockResolvedValue(null);
    expect(await setCallerLanguages(prisma, { subscriptionId: 'x', languages: ['en'], actor })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('un fallo del registro de auditoría no deshace el cambio', async () => {
    state.auditCreate.mockRejectedValue(new Error('db'));
    const result = await setCallerLanguages(prisma, { subscriptionId: 'sub_1', languages: ['en'], actor });
    expect(result).toEqual({ ok: true, callerLanguages: ['es', 'en'], changed: true });
  });
});
