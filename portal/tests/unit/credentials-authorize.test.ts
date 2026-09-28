// =============================================================================
// KAIA-2103 — Credentials authorize unit test.
//
// Verifies the authConfig providers[0].authorize callback:
//   * returns null for missing email or password
//   * returns null for unknown email (no user found)
//   * returns null for user with no passwordHash set
//   * returns null for wrong password
//   * returns user object with id, email, clientId, role for correct credentials
//
// The Prisma client is mocked with vi.fn() stubs. We never touch a real database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @/lib/prisma so auth.ts can load without a real DB connection.
// authorize() does two lookups: prisma.user.findUnique() by email, then
// prisma.chatbotClientUser.findUnique() by userId to resolve clientId.
const findUnique = vi.fn();
const findUniqueClientUser = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUniqueClientUser(...args),
    },
  },
}));

// Mock @/lib/operator-crypto so we can control verifyPassword behavior.
const verifyPassword = vi.fn();

// Parcial: el limitador de intentos y la huella de la contraseña son los
// reales — son parte de lo que se prueba abajo.
vi.mock('@/lib/operator-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operator-crypto')>()),
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
}));

// Import AFTER the mocks are in place.
import { authConfig } from '../../auth';
import { passwordFingerprint } from '@/lib/operator-crypto';

const KNOWN_EMAIL = 'aurora@example.com';
const KNOWN_CLIENT_ID = 'client_aurora_001';
const KNOWN_USER_ID = 'user_aurora_001';
const CORRECT_PASSWORD = 's3cr3tP@ssw0rd';
const WRONG_PASSWORD = 'wrongpassword';

beforeEach(() => {
  findUnique.mockReset();
  findUniqueClientUser.mockReset();
  verifyPassword.mockReset();
});

function buildCredentials(email: string, password: string) {
  return { email, password };
}

// `Credentials(config)` from @auth/core hardcodes `.authorize` to a stub
// that always returns null — the real function you pass in is stashed
// under `.options.authorize`. NextAuth resolves this indirection
// internally when building the request handler, but a unit test that
// imports the raw `authConfig` has to reach through `.options` itself.
function getAuthorize() {
  const provider = authConfig.providers[0] as unknown as {
    options: { authorize: (c: unknown) => Promise<unknown> };
  };
  return provider.options.authorize;
}

describe('authConfig.providers[0].authorize (Credentials)', () => {
  it('returns null when email is missing', async () => {
    const authorize = getAuthorize();
    const result = await authorize({ password: CORRECT_PASSWORD });
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when password is missing', async () => {
    const authorize = getAuthorize();
    const result = await authorize({ email: KNOWN_EMAIL });
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null for unknown email', async () => {
    findUnique.mockResolvedValueOnce(null);
    const authorize = getAuthorize();
    const result = await authorize(buildCredentials('unknown@example.com', CORRECT_PASSWORD));
    expect(result).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'unknown@example.com' },
      select: { id: true, role: true, passwordHash: true },
    });
  });

  it('returns null when user has no passwordHash set', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: null });
    const authorize = getAuthorize();
    const result = await authorize(buildCredentials(KNOWN_EMAIL, CORRECT_PASSWORD));
    expect(result).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns null for wrong password', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(false);
    const authorize = getAuthorize();
    const result = await authorize(buildCredentials(KNOWN_EMAIL, WRONG_PASSWORD));
    expect(result).toBeNull();
    expect(verifyPassword).toHaveBeenCalledWith('argon2hash', WRONG_PASSWORD);
  });

  it('returns user object for correct credentials', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    findUniqueClientUser.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });
    const authorize = getAuthorize();
    const result = await authorize(buildCredentials(KNOWN_EMAIL, CORRECT_PASSWORD));
    expect(result).toEqual({
      id: KNOWN_USER_ID,
      email: KNOWN_EMAIL,
      clientId: KNOWN_CLIENT_ID,
      role: 'client',
      pwf: passwordFingerprint('argon2hash'),
    });
    expect(findUniqueClientUser).toHaveBeenCalledWith({
      where: { userId: KNOWN_USER_ID },
      select: { clientId: true },
    });
  });

  it('normalises email to lower-case before lookup', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    findUniqueClientUser.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });
    const authorize = getAuthorize();
    await authorize(buildCredentials('AURORA@EXAMPLE.COM', CORRECT_PASSWORD));
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: KNOWN_EMAIL },
      select: { id: true, role: true, passwordHash: true },
    });
  });

  it('trims whitespace from email before lookup', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    findUniqueClientUser.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });
    const authorize = getAuthorize();
    await authorize(buildCredentials(`  ${KNOWN_EMAIL}  `, CORRECT_PASSWORD));
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: KNOWN_EMAIL },
      select: { id: true, role: true, passwordHash: true },
    });
  });
});

// Seguridad (22/09/2026): el endpoint de NextAuth no limitaba intentos.
describe('authorize — límite de intentos', () => {
  it('deja de comprobar contraseñas tras 10 intentos seguidos al mismo email', async () => {
    findUnique.mockResolvedValue({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValue(false);
    const authorize = getAuthorize();
    for (let i = 0; i < 12; i++) {
      await authorize(buildCredentials('fuerza-bruta@example.com', `intento-${i}`));
    }
    expect(verifyPassword).toHaveBeenCalledTimes(10);
  });

  it('cuenta la IP real que pone el proxy, no la que escribe el cliente en X-Forwarded-For', async () => {
    findUnique.mockResolvedValue(null);
    const provider = authConfig.providers[0] as unknown as {
      options: { authorize: (c: unknown, r: Request) => Promise<unknown> };
    };
    let lookups = 0;
    findUnique.mockImplementation(async () => {
      lookups++;
      return null;
    });
    for (let i = 0; i < 40; i++) {
      const request = new Request('https://portal.example/api/auth/callback/portal-credentials', {
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7`, 'x-real-ip': '203.0.113.7' },
      });
      await provider.options.authorize(buildCredentials(`probe-${i}@example.com`, 'x'), request);
    }
    expect(lookups).toBe(30);
  });
});

describe('authConfig.callbacks.jwt', () => {
  it('embeds clientId and role from user into token', async () => {
    const jwt = authConfig.callbacks?.jwt;
    expect(jwt).toBeTypeOf('function');
    findUnique.mockResolvedValueOnce({ passwordHash: 'argon2hash' });
    const token = await jwt!({
      token: { sub: 'u1' },
      user: { id: 'u1', email: 'a@b.com', clientId: 'cid1', role: 'client', pwf: passwordFingerprint('argon2hash') } as never,
    } as never);
    expect(token).toMatchObject({ clientId: 'cid1', role: 'client' });
  });

  it('passes token through when no user', async () => {
    const jwt = authConfig.callbacks?.jwt;
    const token = { foo: 'bar' };
    const result = await jwt!({ token, user: undefined } as never);
    expect(result).toEqual(token);
  });

  // Seguridad (22/09/2026): antes el JWT valía 30 días pasara lo que pasara.
  it('cambiar la contraseña cierra las sesiones abiertas: la huella ya no coincide', async () => {
    const jwt = authConfig.callbacks?.jwt;
    findUnique.mockResolvedValueOnce({ passwordHash: 'hash-nuevo-tras-el-cambio' });
    const result = await jwt!({
      token: { sub: 'u1', role: 'client', pwf: passwordFingerprint('hash-antiguo') },
      user: undefined,
    } as never);
    expect(result).toBeNull();
  });

  it('una contraseña pendiente de resetear por soporte también las cierra', async () => {
    const jwt = authConfig.callbacks?.jwt;
    findUnique.mockResolvedValueOnce({ passwordHash: '__must_reset__' });
    const result = await jwt!({
      token: { sub: 'u1', role: 'client', pwf: passwordFingerprint('hash-antiguo') },
      user: undefined,
    } as never);
    expect(result).toBeNull();
  });

  it('con la misma contraseña, el token sigue valiendo', async () => {
    const jwt = authConfig.callbacks?.jwt;
    findUnique.mockResolvedValueOnce({ passwordHash: 'argon2hash' });
    const token = { sub: 'u1', role: 'client', pwf: passwordFingerprint('argon2hash') };
    expect(await jwt!({ token, user: undefined } as never)).toEqual(token);
  });

  it('un JWT de operador (entrada retirada) ya no abre nada', async () => {
    const jwt = authConfig.callbacks?.jwt;
    const result = await jwt!({ token: { sub: 'op1', role: 'operator' }, user: undefined } as never);
    expect(result).toBeNull();
  });
});

describe('authConfig.callbacks.session', () => {
  it('embeds clientId and role from token into session.user', async () => {
    const session = authConfig.callbacks?.session;
    expect(session).toBeTypeOf('function');
    const user = {};
    const result = await session!({
      session: { user },
      token: { clientId: 'cid1', role: 'client' },
    });
    expect(result.user).toMatchObject({ clientId: 'cid1', role: 'client' });
  });
});

// Revisión de seguridad del 22/09/2026 — un alta de autoservicio no puede
// entrar (ni, por tanto, pagar) hasta confirmar el email. Ver
// src/lib/pending-signup.ts.
describe('authConfig.providers[0].authorize — self-serve signup pending verification', () => {
  it('rejects a pending signup even with the right password, without checking it', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, role: 'client', passwordHash: 'pending:argon2hash' });
    const authorize = getAuthorize();
    const result = await authorize(buildCredentials(KNOWN_EMAIL, CORRECT_PASSWORD));
    expect(result).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});
