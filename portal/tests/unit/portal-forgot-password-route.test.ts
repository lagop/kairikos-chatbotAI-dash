// =============================================================================
// POST /api/portal/forgot-password — revisión de seguridad del 30/09/2026.
//
// Dos cosas que la versión del operador ya tenía y la del cliente no:
//   - límite de intentos (antes, con un bucle se bombardeaba un buzón);
//   - no revelar si la cuenta existe (antes, un fallo de envío devolvía 500
//     SOLO cuando la cuenta existía).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  findClientUser: vi.fn(),
  findUser: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatbotClientUser: { findUnique: (...a: unknown[]) => mockState.findClientUser(...a) },
    user: { findUnique: (...a: unknown[]) => mockState.findUser(...a) },
    passwordResetToken: { updateMany: async () => ({ count: 0 }), create: async () => ({}) },
  },
}));
vi.mock('@/lib/auth-email', () => ({
  sendEmail: (...a: unknown[]) => mockState.sendEmail(...a),
  buildPasswordResetHtml: () => '<p></p>',
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import { POST } from '@/app/api/portal/forgot-password/route';

let ip = 0;
function req(email: string) {
  ip += 1;
  return {
    json: async () => ({ email }),
    headers: new Headers({ 'x-real-ip': `198.51.100.${ip % 250}` }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.findClientUser.mockReset().mockResolvedValue({ id: 'cu1', userId: 'u1' });
  mockState.findUser.mockReset().mockResolvedValue({ id: 'u1', passwordHash: 'hash' });
  mockState.sendEmail.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
});

describe('POST /api/portal/forgot-password', () => {
  it('si el envío falla, responde lo mismo que si la cuenta no existiera', async () => {
    mockState.sendEmail.mockRejectedValue(new Error('resend caído'));
    const existe = await POST(req('existe@ejemplo.es'));
    mockState.findClientUser.mockResolvedValue(null);
    const noExiste = await POST(req('no-existe@ejemplo.es'));
    expect(existe.status).toBe(200);
    expect(await existe.json()).toEqual({ ok: true });
    expect(noExiste.status).toBe(200);
    expect(await noExiste.json()).toEqual({ ok: true });
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('a partir del sexto intento al mismo correo en 15 min, 429 — exista o no', async () => {
    mockState.findClientUser.mockResolvedValue(null);
    const estados = [];
    for (let i = 0; i < 7; i++) estados.push((await POST(req('bucle@ejemplo.es'))).status);
    expect(estados.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(estados.slice(5)).toEqual([429, 429]);
  });
});
