// KAIA-12714 — Reset the password for an operator (support) account using a
// valid single-use token. Mirrors `/api/portal/reset-password` but wired to
// the `Operator` Prisma model + the existing `hashPassword` helper in
// `operator-crypto.ts` (argon2id, matching the existing Operator.passwordHash
// shape — `verifyPassword` from the same module keeps working for the
// `/api/operator/login` route).
//
// Failure semantics:
//   * Body validation fails       → 400 { error: 'invalid_body' }
//   * DB not configured           → 503 { error: 'service_unavailable' }
//   * Token not found / expired / already-used / email mismatch
//                                → 400 { error: 'invalid_or_expired_token' }
//   * Operator not mapped         → 404 { error: 'operator_not_found' }
//   * Operator inactive           → 403 { error: 'operator_inactive' }
//   * argon2 / DB error           → 500 { error: 'internal_error' }
//
// On success the passwordHash is updated, the token is burned, the
// operator's `lastLoginAt` is NOT touched (the operator has not signed
// in yet — they still need to hit /api/operator/login). The plaintext
// password never leaves this function.
//
// Revokes all of the operator's existing sessions when the reset
// succeeds — KAIA-12714 follow-up note: this prevents a stolen
// pre-reset session cookie from outliving the password change.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashPassword } from '@/lib/operator-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ResetPasswordSchema = z.object({
  email: z.string().email(),
  token: z.string().min(64).max(64),
  password: z.string().min(8).max(128),
});

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { email, token, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const tokenHash = hashToken(token);

  const record = await prisma.passwordResetToken.findFirst({
    where: {
      email: normalizedEmail,
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, isActive: true },
  });

  if (!operator) {
    return NextResponse.json({ error: 'operator_not_found' }, { status: 404 });
  }

  if (!operator.isActive) {
    return NextResponse.json({ error: 'operator_inactive' }, { status: 403 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.operator.update({
      where: { id: operator.id },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    // Revoke any pre-reset sessions — a stolen session cookie must not
    // outlive the password change.
    prisma.operatorSession.updateMany({
      where: { operatorId: operator.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return NextResponse.json({ ok: true });
}