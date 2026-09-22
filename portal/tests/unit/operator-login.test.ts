// =============================================================================
// Seguridad (22/09/2026) — entrada del operador con segundo factor
// obligatorio. Ver src/lib/operator-login.ts.
//
// Lo que se prueba es lo que antes fallaba: que la contraseña sola no crea
// sesión, que un código TOTP no sirve dos veces, que los intentos tienen
// tope, y que el alta del autenticador exige el código del email.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { authenticator } from '@otplib/preset-default';

const state = vi.hoisted(() => ({
  operatorFindUnique: vi.fn(),
  operatorUpdate: vi.fn(),
  operatorUpdateMany: vi.fn(),
  recoveryUpdateMany: vi.fn(),
  recoveryDeleteMany: vi.fn(),
  recoveryCreateMany: vi.fn(),
  transaction: vi.fn(),
  verifyPassword: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  createSession: vi.fn(),
  sendOperatorEnrollmentCode: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    operator: {
      findUnique: (...a: unknown[]) => state.operatorFindUnique(...a),
      update: (...a: unknown[]) => state.operatorUpdate(...a),
      updateMany: (...a: unknown[]) => state.operatorUpdateMany(...a),
    },
    operatorRecoveryCode: {
      updateMany: (...a: unknown[]) => state.recoveryUpdateMany(...a),
      deleteMany: (...a: unknown[]) => state.recoveryDeleteMany(...a),
      createMany: (...a: unknown[]) => state.recoveryCreateMany(...a),
    },
    $transaction: (...a: unknown[]) => state.transaction(...a),
  },
}));

// Cifrado del secreto TOTP: identidad, para leer el secreto en claro en los
// tests. Argon2 fuera: lento y no es lo que se prueba.
vi.mock('@/lib/operator-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operator-crypto')>()),
  encryptTotpSecret: (s: string) => `enc:${s}`,
  decryptTotpSecret: (s: string) => s.replace(/^enc:/, ''),
  verifyPassword: (...a: unknown[]) => state.verifyPassword(...a),
  verifyRecoveryCode: (...a: unknown[]) => state.verifyRecoveryCode(...a),
  hashRecoveryCode: async (c: string) => `hashed:${c}`,
}));

vi.mock('@/lib/operator-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operator-session')>()),
  createSession: (...a: unknown[]) => state.createSession(...a),
}));

vi.mock('@/lib/auth-email', () => ({
  sendOperatorEnrollmentCode: (...a: unknown[]) => state.sendOperatorEnrollmentCode(...a),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

process.env.AUTH_SECRET = 'test-auth-secret-que-no-es-de-verdad';

import {
  signLoginChallenge,
  readLoginChallenge,
  hashEmailCode,
  emailCodeMatches,
  matchTotpStep,
  verifySecondFactor,
  SECOND_FACTOR_ATTEMPTS_PER_WINDOW,
} from '@/lib/operator-login';
import { passwordFingerprint } from '@/lib/operator-crypto';
import { POST as loginPOST } from '@/app/api/operator/login/route';
import { POST as emailCodePOST } from '@/app/api/operator/login/email-code/route';
import { POST as totpPOST } from '@/app/api/operator/login/totp/route';
import { prisma } from '@/lib/prisma';

const SECRET = authenticator.generateSecret();
const PASSWORD_HASH = 'argon2-hash-de-la-contraseña';
const PW = passwordFingerprint(PASSWORD_HASH);
let operatorSeq = 0;

function operator(overrides: Record<string, unknown> = {}) {
  operatorSeq += 1;
  return {
    id: `op_${operatorSeq}`,
    email: 'lucia@kairikos.com',
    passwordHash: PASSWORD_HASH,
    isActive: true,
    totpEnrolledAt: new Date('2026-01-01'),
    totpSecret: `enc:${SECRET}`,
    lastTotpAt: null as Date | null,
    recoveryCodes: [] as { id: string; codeHash: string; consumedAt: Date | null }[],
    ...overrides,
  };
}

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return { json: async () => body, headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.operatorUpdate.mockResolvedValue({});
  state.operatorUpdateMany.mockResolvedValue({ count: 1 });
  state.recoveryUpdateMany.mockResolvedValue({ count: 1 });
  state.transaction.mockResolvedValue([]);
  state.createSession.mockResolvedValue('sess_new');
  state.sendOperatorEnrollmentCode.mockResolvedValue(undefined);
  state.verifyRecoveryCode.mockResolvedValue(false);
});

describe('reto firmado entre la contraseña y el código', () => {
  it('se lee de vuelta con su etapa', () => {
    const token = signLoginChallenge({ op: 'op_1', st: 'totp', pw: PW })!;
    expect(readLoginChallenge(token, 'totp')).toMatchObject({ op: 'op_1', st: 'totp', pw: PW });
  });

  it('no vale para otra etapa', () => {
    const token = signLoginChallenge({ op: 'op_1', st: 'email_code', pw: PW })!;
    expect(readLoginChallenge(token, 'totp')).toBeNull();
  });

  it('manipulado, deja de valer (cambiar el operador rompe la firma)', () => {
    const token = signLoginChallenge({ op: 'op_1', st: 'totp', pw: PW })!;
    const [body, mac] = token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.op = 'op_victima';
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
    expect(readLoginChallenge(`${forgedBody}.${mac}`, 'totp')).toBeNull();
  });

  it('caduca a los 10 minutos', () => {
    const t0 = Date.now();
    const token = signLoginChallenge({ op: 'op_1', st: 'totp', pw: PW }, t0)!;
    expect(readLoginChallenge(token, 'totp', t0 + 9 * 60_000)).not.toBeNull();
    expect(readLoginChallenge(token, 'totp', t0 + 11 * 60_000)).toBeNull();
  });

  it('el código del email solo casa con el suyo', () => {
    const ec = hashEmailCode('op_1', '123456')!;
    const challenge = { op: 'op_1', st: 'email_code' as const, pw: PW, exp: Date.now() + 1000, ec };
    expect(emailCodeMatches(challenge, '123456')).toBe(true);
    expect(emailCodeMatches(challenge, '123457')).toBe(false);
    expect(emailCodeMatches({ ...challenge, op: 'op_2' }, '123456')).toBe(false);
  });
});

describe('verifySecondFactor', () => {
  it('reconoce el intervalo de 30 s del código', () => {
    const now = Date.UTC(2026, 8, 22, 10, 0, 5);
    const code = authenticator.clone({ epoch: now }).generate(SECRET);
    expect(matchTotpStep(code, SECRET, now)).toBe(Math.floor(now / 30_000));
  });

  it('un código válido pasa, y reclama su intervalo con una escritura condicional', async () => {
    const now = Date.UTC(2026, 8, 22, 10, 0, 5);
    const op = operator();
    const code = authenticator.clone({ epoch: now }).generate(SECRET);
    const res = await verifySecondFactor(prisma, op, code, { allowRecoveryCode: true, now });
    expect(res).toEqual({ ok: true, method: 'totp' });
    const stepStart = new Date(Math.floor(now / 30_000) * 30_000);
    expect(state.operatorUpdateMany).toHaveBeenCalledWith({
      where: { id: op.id, OR: [{ lastTotpAt: null }, { lastTotpAt: { lt: stepStart } }] },
      data: { lastTotpAt: stepStart },
    });
  });

  it('el mismo código no sirve dos veces: si otro ya reclamó su intervalo, falla', async () => {
    const now = Date.UTC(2026, 8, 22, 10, 0, 5);
    const code = authenticator.clone({ epoch: now }).generate(SECRET);
    state.operatorUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await verifySecondFactor(prisma, operator(), code, { allowRecoveryCode: true, now });
    expect(res).toEqual({ ok: false, error: 'invalid_code' });
  });

  it(`tras ${SECOND_FACTOR_ATTEMPTS_PER_WINDOW} intentos, deja de comprobar`, async () => {
    const op = operator();
    for (let i = 0; i < SECOND_FACTOR_ATTEMPTS_PER_WINDOW; i++) {
      expect((await verifySecondFactor(prisma, op, '000000', { allowRecoveryCode: false })).ok).toBe(false);
    }
    const good = authenticator.generate(SECRET);
    expect(await verifySecondFactor(prisma, op, good, { allowRecoveryCode: false })).toEqual({
      ok: false,
      error: 'too_many_attempts',
    });
  });

  it('acepta un código de recuperación y lo gasta', async () => {
    state.verifyRecoveryCode.mockImplementation(async (hash: string, code: string) => hash === `h:${code}`);
    const op = operator({ recoveryCodes: [{ id: 'rc_1', codeHash: 'h:abc123def456', consumedAt: null }] });
    const res = await verifySecondFactor(prisma, op, 'abc123def456', { allowRecoveryCode: true });
    expect(res).toEqual({ ok: true, method: 'recovery_code' });
    expect(state.recoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rc_1', consumedAt: null } }),
    );
  });

  it('en el alta no se aceptan códigos de recuperación', async () => {
    state.verifyRecoveryCode.mockResolvedValue(true);
    const op = operator({ recoveryCodes: [{ id: 'rc_1', codeHash: 'x', consumedAt: null }] });
    const res = await verifySecondFactor(prisma, op, 'abc123def456', { allowRecoveryCode: false });
    expect(res).toEqual({ ok: false, error: 'invalid_code' });
  });
});

describe('POST /api/operator/login — la contraseña sola no crea sesión', () => {
  it('con TOTP: devuelve el reto del código, sin cookie ni sesión', async () => {
    const op = operator();
    state.operatorFindUnique.mockResolvedValueOnce(op);
    state.verifyPassword.mockResolvedValueOnce(true);
    const res = await loginPOST(req({ email: 'Lucia@Kairikos.com', password: 'bien' }, { 'x-real-ip': '198.51.100.1' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.step).toBe('totp');
    expect(readLoginChallenge(body.challenge, 'totp')).toMatchObject({ op: op.id, pw: PW });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(state.createSession).not.toHaveBeenCalled();
  });

  it('contraseña mala: 401, sin reto', async () => {
    state.operatorFindUnique.mockResolvedValueOnce(operator());
    state.verifyPassword.mockResolvedValueOnce(false);
    const res = await loginPOST(req({ email: 'lucia2@kairikos.com', password: 'mal' }, { 'x-real-ip': '198.51.100.2' }));
    expect(res.status).toBe(401);
    expect((await res.json()).challenge).toBeUndefined();
  });

  it('sin TOTP todavía: envía un código al email del operador', async () => {
    state.operatorFindUnique.mockResolvedValueOnce(operator({ totpEnrolledAt: null, totpSecret: null }));
    state.verifyPassword.mockResolvedValueOnce(true);
    const res = await loginPOST(req({ email: 'nuevo@kairikos.com', password: 'bien' }, { 'x-real-ip': '198.51.100.3' }));
    const body = await res.json();
    expect(body.step).toBe('email_code');
    expect(state.sendOperatorEnrollmentCode).toHaveBeenCalledWith({ to: 'lucia@kairikos.com', code: expect.stringMatching(/^\d{6}$/) });
  });

  it('si el email no sale, lo dice en vez de dejar seguir', async () => {
    state.operatorFindUnique.mockResolvedValueOnce(operator({ totpEnrolledAt: null, totpSecret: null }));
    state.verifyPassword.mockResolvedValueOnce(true);
    state.sendOperatorEnrollmentCode.mockRejectedValueOnce(new Error('RESEND_API_KEY is not configured'));
    const res = await loginPOST(req({ email: 'sinmail@kairikos.com', password: 'bien' }, { 'x-real-ip': '198.51.100.4' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('email_unavailable');
  });

  it('el límite por IP usa la IP del proxy: cambiar X-Forwarded-For no lo esquiva', async () => {
    state.operatorFindUnique.mockResolvedValue(null);
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await loginPOST(
        req({ email: `x${i}@kairikos.com`, password: 'x' }, { 'x-forwarded-for': `1.2.3.${i}`, 'x-real-ip': '198.51.100.99' }),
      );
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('POST /api/operator/login/totp — la sesión nace aquí', () => {
  it('código válido: crea la sesión y pone la cookie', async () => {
    const op = operator();
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'totp', pw: PW });
    const res = await totpPOST(req({ challenge, code: authenticator.generate(SECRET) }, { 'x-real-ip': '198.51.100.5' }));
    expect(res.status).toBe(200);
    expect(state.createSession).toHaveBeenCalledWith(op.id, '198.51.100.5', null);
    expect(res.headers.get('set-cookie')).toContain('kairikos_operator_session=sess_new');
  });

  it('código malo: 401 y ninguna sesión', async () => {
    const op = operator();
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'totp', pw: PW });
    const res = await totpPOST(req({ challenge, code: '000000' }));
    expect(res.status).toBe(401);
    expect(state.createSession).not.toHaveBeenCalled();
  });

  it('si la contraseña cambió desde el primer paso, el reto ya no vale', async () => {
    const op = operator({ passwordHash: 'otro-hash-tras-un-reset' });
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'totp', pw: PW });
    const res = await totpPOST(req({ challenge, code: authenticator.generate(SECRET) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('challenge_expired');
  });

  it('un operador desactivado entre medias no entra', async () => {
    const op = operator({ isActive: false });
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'totp', pw: PW });
    const res = await totpPOST(req({ challenge, code: authenticator.generate(SECRET) }));
    expect(res.status).toBe(401);
  });
});

describe('alta del TOTP en la entrada — exige el código del email', () => {
  it('sin el código del email correcto no se genera ningún secreto', async () => {
    const op = operator({ totpEnrolledAt: null, totpSecret: null });
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'email_code', pw: PW, ec: hashEmailCode(op.id, '424242')! });
    const res = await emailCodePOST(req({ challenge, code: '111111' }));
    expect(res.status).toBe(401);
    expect(state.operatorUpdate).not.toHaveBeenCalled();
  });

  it('con el código correcto: guarda el secreto nuevo y pide confirmarlo con la app', async () => {
    const op = operator({ totpEnrolledAt: null, totpSecret: null });
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'email_code', pw: PW, ec: hashEmailCode(op.id, '424242')! });
    const res = await emailCodePOST(req({ challenge, code: '424242' }));
    const body = await res.json();
    expect(body.step).toBe('enroll_confirm');
    expect(readLoginChallenge(body.challenge, 'enroll_confirm')).toMatchObject({ op: op.id });
    expect(state.operatorUpdate).toHaveBeenCalledWith({
      where: { id: op.id },
      data: { totpSecret: `enc:${body.secret}`, lastTotpAt: null },
    });
  });

  it('un operador que ya tiene TOTP no puede volver a darlo de alta por aquí', async () => {
    const op = operator();
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'email_code', pw: PW, ec: hashEmailCode(op.id, '424242')! });
    const res = await emailCodePOST(req({ challenge, code: '424242' }));
    expect(res.status).toBe(409);
  });

  it('el primer código de la app termina el alta, entrega los códigos de recuperación y abre la sesión', async () => {
    const op = operator({ totpEnrolledAt: null });
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'enroll_confirm', pw: PW });
    const res = await totpPOST(req({ challenge, code: authenticator.generate(SECRET) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.recoveryCodes).toHaveLength(8);
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.createSession).toHaveBeenCalled();
  });

  it('un reto de alta no sirve para un operador que ya estaba dado de alta', async () => {
    const op = operator();
    state.operatorFindUnique.mockResolvedValueOnce(op);
    const challenge = signLoginChallenge({ op: op.id, st: 'enroll_confirm', pw: PW });
    const res = await totpPOST(req({ challenge, code: authenticator.generate(SECRET) }));
    expect(res.status).toBe(401);
    expect(state.createSession).not.toHaveBeenCalled();
  });
});
