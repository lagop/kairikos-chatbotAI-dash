// =============================================================================
// Seguridad (22/09/2026) — cuándo vale una OperatorSession. Ver
// getValidSession en src/lib/operator-session.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const create = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    operatorSession: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import { getValidSession, createSession, SESSION_IDLE_TIMEOUT_MS } from '@/lib/operator-session';

const NOW = Date.now();

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess_1',
    operatorId: 'op_1',
    totpVerifiedAt: new Date(NOW - 60_000),
    lastUsedAt: new Date(NOW - 60_000),
    expiresAt: new Date(NOW + 24 * 3600_000),
    revokedAt: null,
    operator: { email: 'lucia@kairikos.com', isActive: true },
    ...overrides,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  create.mockReset().mockResolvedValue({ id: 'sess_new' });
});

describe('getValidSession', () => {
  it('una sesión sana vale y trae el email del operador', async () => {
    findUnique.mockResolvedValueOnce(row());
    expect(await getValidSession('sess_1')).toMatchObject({ operatorId: 'op_1', email: 'lucia@kairikos.com' });
  });

  it('una sesión que nunca pasó el segundo factor no vale (las de la entrada antigua, solo con contraseña)', async () => {
    findUnique.mockResolvedValueOnce(row({ totpVerifiedAt: null }));
    expect(await getValidSession('sess_1')).toBeNull();
  });

  it('sin usar en más de 12 horas, muere aunque no haya caducado', async () => {
    findUnique.mockResolvedValueOnce(row({ lastUsedAt: new Date(NOW - SESSION_IDLE_TIMEOUT_MS - 60_000) }));
    expect(await getValidSession('sess_1')).toBeNull();
  });

  it('desactivar al operador cierra sus sesiones al instante', async () => {
    findUnique.mockResolvedValueOnce(row({ operator: { email: 'lucia@kairikos.com', isActive: false } }));
    expect(await getValidSession('sess_1')).toBeNull();
  });

  it('revocada o caducada, no vale', async () => {
    findUnique.mockResolvedValueOnce(row({ revokedAt: new Date() }));
    expect(await getValidSession('sess_1')).toBeNull();
    findUnique.mockResolvedValueOnce(row({ expiresAt: new Date(NOW - 1000) }));
    expect(await getValidSession('sess_1')).toBeNull();
  });
});

describe('createSession', () => {
  it('nace con el segundo factor verificado: solo la llama la entrada después del código', async () => {
    await createSession('op_1', '198.51.100.1', 'Firefox');
    const data = create.mock.calls[0][0].data;
    expect(data.totpVerifiedAt).toBeInstanceOf(Date);
    expect(data.operatorId).toBe('op_1');
  });
});
