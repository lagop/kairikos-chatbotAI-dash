// =============================================================================
// Seguridad (22/09/2026) — PATCH /api/admin/portal/clients/[id].
//
// Cambiar el email de un cliente resetea su contraseña y manda el enlace
// para crear otra al email nuevo: es quedarse con la cuenta. Ese cambio, y
// solo ese, pide TOTP reciente además de la sesión de operador.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatbotClient: { findUnique: (...a: unknown[]) => state.findUnique(...a) },
    $transaction: (...a: unknown[]) => state.transaction(...a),
  },
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => state.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => state.requireTotpStepUp(...a),
}));
vi.mock('@/lib/auth-email', () => ({ sendSetupPassword: vi.fn(), SETUP_EMAIL_LINK_EXPIRY_DAYS: 7 }));
vi.mock('@/lib/client-product-lifecycle', () => ({ mirrorChatbotStateToClientProduct: vi.fn() }));

import { PATCH } from '@/app/api/admin/portal/clients/[id]/route';

const CURRENT = {
  companyName: 'Fontanería Aurora',
  email: 'aurora@example.com',
  tier: 'starter',
  goLiveAt: null,
  state: 'live',
  notes: null,
};

function patch(body: unknown) {
  return PATCH({ json: async () => body } as unknown as NextRequest, { params: { id: 'client_1' } });
}

beforeEach(() => {
  state.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  state.requireTotpStepUp.mockReset().mockResolvedValue({ ok: false, status: 403, error: 'totp_step_up_required' });
  state.findUnique.mockReset().mockResolvedValue(CURRENT);
  // Si la ruta llega a escribir, se corta aquí: estos tests son sobre la
  // puerta, no sobre la escritura.
  state.transaction.mockReset().mockRejectedValue(new Error('no_escribir_en_este_test'));
});

describe('PATCH /api/admin/portal/clients/[id] — TOTP solo para el cambio de email', () => {
  it('cambiar el email sin TOTP reciente: 403 y no se escribe nada', async () => {
    const res = await patch({ email: 'atacante@example.com' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('totp_step_up_required');
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it('con TOTP reciente, el cambio de email pasa la puerta', async () => {
    state.requireTotpStepUp.mockResolvedValueOnce({ ok: true, operatorId: 'op_1', sessionId: 's1' });
    await patch({ email: 'nuevo@example.com' });
    expect(state.transaction).toHaveBeenCalled();
  });

  it('cambiar la tarifa o las notas no pide TOTP', async () => {
    await patch({ tier: 'pro', notes: 'Llamar el lunes' });
    expect(state.requireTotpStepUp).not.toHaveBeenCalled();
    expect(state.transaction).toHaveBeenCalled();
  });

  it('mandar el mismo email que ya tiene no cuenta como cambio', async () => {
    await patch({ email: 'AURORA@example.com' });
    expect(state.requireTotpStepUp).not.toHaveBeenCalled();
  });
});
