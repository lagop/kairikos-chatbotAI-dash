import { prisma } from './prisma';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'kairikos_operator_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TOTP_STEPUP_TTL_MS = 5 * 60 * 1000;

export function getSessionCookieId(req: NextRequest): string | null {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  return cookie?.value ?? null;
}

export function setSessionCookie(
  sessionId: string,
): { name: string; value: string; options: Record<string, string | number | boolean> } {
  return {
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS / 1000,
    },
  };
}

export function clearSessionCookie(): { name: string; value: string; options: Record<string, string | number | boolean> } {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    },
  };
}

export async function createSession(
  operatorId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<string> {
  const now = new Date();
  const session = await prisma.operatorSession.create({
    data: {
      operatorId,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS),
      ip,
      userAgent,
    },
  });
  return session.id;
}

export async function getValidSession(sessionId: string): Promise<{
  operatorId: string;
  totpVerifiedAt: Date | null;
} | null> {
  try {
    const session = await prisma.operatorSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt < new Date()) return null;
    return { operatorId: session.operatorId, totpVerifiedAt: session.totpVerifiedAt };
  } catch {
    return null;
  }
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.operatorSession.update({
    where: { id: sessionId },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.operatorSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  }).catch(() => {});
}

export async function markTotpVerified(sessionId: string): Promise<void> {
  await prisma.operatorSession.update({
    where: { id: sessionId },
    data: { totpVerifiedAt: new Date() },
  });
}

export function isTotpStillVerified(totpVerifiedAt: Date | null): boolean {
  if (!totpVerifiedAt) return false;
  return Date.now() - totpVerifiedAt.getTime() < TOTP_STEPUP_TTL_MS;
}

/**
 * Authenticate an admin portal request. Priority:
 * 1. Valid operator session cookie
 * 2. Legacy `x-kaia-operator-key` header matching KAIA_OPERATOR_API_KEY
 *
 * Logs a WARN when the legacy fallback is used. Returns null if both fail.
 */
export async function authenticateAdminRequest(req: NextRequest): Promise<{
  ok: true; sessionId: string; operatorId: string
} | { ok: false }> {
  const sessionId = getSessionCookieId(req);
  if (sessionId) {
    const session = await getValidSession(sessionId);
    if (session) {
      touchSession(sessionId).catch(() => {});
      return { ok: true, sessionId, operatorId: session.operatorId };
    }
  }

  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (envKey) {
    const provided = req.headers.get('x-kaia-operator-key');
    if (provided && provided === envKey) {
      const ip = req.headers.get('x-forwarded-for') ?? 'unknown';
      console.warn(
        `[WARN] Legacy KAIA_OPERATOR_API_KEY auth used from IP ${ip} for ${req.nextUrl.pathname}`,
      );
      return { ok: true, sessionId: 'legacy', operatorId: 'legacy' };
    }
  }

  return { ok: false };
}
