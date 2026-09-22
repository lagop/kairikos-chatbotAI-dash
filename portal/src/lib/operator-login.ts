import 'server-only';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { authenticator } from '@otplib/preset-default';
import { constantTimeEqual, decryptTotpSecret, InMemoryRateLimiter, verifyRecoveryCode } from './operator-crypto';

export { passwordFingerprint } from './operator-crypto';

// =============================================================================
// Entrada del operador con segundo factor obligatorio (22/09/2026).
//
// Antes: la contraseña sola daba acceso a todo el admin (el TOTP solo se
// pedía en 18 acciones concretas), el endpoint de NextAuth no limitaba
// intentos, el de TOTP tampoco y aceptaba repetir un código ya usado, y
// cualquiera con la contraseña de un operador sin TOTP podía registrar su
// propio autenticador.
//
// Ahora la sesión de operador (OperatorSession) solo se crea después del
// segundo factor, y entre la contraseña y el código viaja un reto firmado —
// no una sesión a medias — que caduca en 10 minutos:
//
//   contraseña ──► reto 'totp'        ──► código TOTP o de recuperación ──► sesión
//             └──► reto 'email_code'  ──► código enviado al email del operador
//                  (sin TOTP todavía)     └──► reto 'enroll_confirm' ──► primer código TOTP ──► sesión
//
// El reto lleva la huella de la contraseña: si se cambia entre medias, deja
// de valer. La clave de firma sale de AUTH_SECRET, que producción ya tiene.
// =============================================================================

const CHALLENGE_TTL_MS = 10 * 60_000;
const TOTP_STEP_MS = 30_000;

export type ChallengeStage = 'totp' | 'email_code' | 'enroll_confirm';

export interface LoginChallenge {
  /** operatorId */
  op: string;
  st: ChallengeStage;
  exp: number;
  /** huella de la contraseña al emitir el reto */
  pw: string;
  /** HMAC del código enviado por email (solo en 'email_code') */
  ec?: string;
}

function challengeKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(`kairikos-operator-login:${secret}`).digest();
}

export function isLoginChallengeConfigured(): boolean {
  return challengeKey() !== null;
}

export function signLoginChallenge(payload: Omit<LoginChallenge, 'exp'>, now = Date.now()): string | null {
  const key = challengeKey();
  if (!key) return null;
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + CHALLENGE_TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** El reto, si es auténtico, de la etapa pedida y no ha caducado. */
export function readLoginChallenge(token: unknown, stage: ChallengeStage, now = Date.now()): LoginChallenge | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const key = challengeKey();
  if (!key) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (!constantTimeEqual(mac, expected)) return null;
  let payload: LoginChallenge;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LoginChallenge;
  } catch {
    return null;
  }
  if (payload?.st !== stage || typeof payload.op !== 'string' || typeof payload.pw !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Código por email para dar de alta el TOTP por primera vez
// ---------------------------------------------------------------------------

export function generateEmailCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashEmailCode(operatorId: string, code: string): string | null {
  const key = challengeKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`${operatorId}:${code.trim()}`).digest('base64url');
}

export function emailCodeMatches(challenge: LoginChallenge, code: unknown): boolean {
  if (typeof code !== 'string' || !challenge.ec) return false;
  const hashed = hashEmailCode(challenge.op, code);
  return hashed !== null && constantTimeEqual(hashed, challenge.ec);
}

// ---------------------------------------------------------------------------
// Segundo factor
// ---------------------------------------------------------------------------

// Compartido entre la entrada y el TOTP de las acciones sensibles: un
// atacante no gana intentos por alternar entre las dos rutas. Con la ventana
// de ±30 s hay 3 códigos válidos de 10⁶ a la vez; 10 intentos cada 15
// minutos lo dejan en años. En memoria: por proceso, y hay uno solo.
const attemptLimiter = new InMemoryRateLimiter(15 * 60_000);
export const SECOND_FACTOR_ATTEMPTS_PER_WINDOW = 10;

export function takeSecondFactorAttempt(operatorId: string): boolean {
  return attemptLimiter.check(`op:${operatorId}`, SECOND_FACTOR_ATTEMPTS_PER_WINDOW);
}

/** El intervalo de 30 s al que corresponde el código, o null si no vale. */
export function matchTotpStep(code: string, secret: string, now = Date.now()): number | null {
  const checker = authenticator.clone({ window: [1, 1], epoch: now });
  let delta: number | null;
  try {
    delta = checker.checkDelta(code.replace(/\s+/g, ''), secret);
  } catch {
    return null;
  }
  if (delta === null) return null;
  return Math.floor(now / TOTP_STEP_MS) + delta;
}

export interface SecondFactorOperator {
  id: string;
  totpSecret: string | null;
  lastTotpAt: Date | null;
  recoveryCodes?: { id: string; codeHash: string; consumedAt: Date | null }[];
}

export type SecondFactorResult =
  | { ok: true; method: 'totp' | 'recovery_code' }
  | { ok: false; error: 'too_many_attempts' | 'invalid_code' | 'totp_not_enrolled' };

/**
 * Comprueba un código TOTP (o de recuperación) sin dejar que se use dos
 * veces. `lastTotpAt` guarda el INICIO del intervalo del último código
 * aceptado; un código de ese intervalo o de uno anterior se rechaza. La
 * escritura es condicional, así que dos peticiones simultáneas con el mismo
 * código no pueden pasar las dos. Nunca lanza.
 */
export async function verifySecondFactor(
  prisma: PrismaClient,
  operator: SecondFactorOperator,
  code: unknown,
  options: { allowRecoveryCode: boolean; now?: number },
): Promise<SecondFactorResult> {
  if (typeof code !== 'string' || code.trim().length === 0 || code.length > 64) {
    return { ok: false, error: 'invalid_code' };
  }
  if (!operator.totpSecret) return { ok: false, error: 'totp_not_enrolled' };
  if (!takeSecondFactorAttempt(operator.id)) return { ok: false, error: 'too_many_attempts' };

  const now = options.now ?? Date.now();
  let secret: string;
  try {
    secret = decryptTotpSecret(operator.totpSecret);
  } catch {
    return { ok: false, error: 'invalid_code' };
  }

  const step = matchTotpStep(code, secret, now);
  if (step !== null) {
    const stepStart = new Date(step * TOTP_STEP_MS);
    const claimed = await prisma.operator.updateMany({
      where: { id: operator.id, OR: [{ lastTotpAt: null }, { lastTotpAt: { lt: stepStart } }] },
      data: { lastTotpAt: stepStart },
    });
    return claimed.count === 1 ? { ok: true, method: 'totp' } : { ok: false, error: 'invalid_code' };
  }

  if (options.allowRecoveryCode) {
    for (const rc of operator.recoveryCodes ?? []) {
      if (rc.consumedAt) continue;
      if (!(await verifyRecoveryCode(rc.codeHash, code.trim()))) continue;
      const consumed = await prisma.operatorRecoveryCode.updateMany({
        where: { id: rc.id, consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      if (consumed.count === 1) return { ok: true, method: 'recovery_code' };
    }
  }
  return { ok: false, error: 'invalid_code' };
}
