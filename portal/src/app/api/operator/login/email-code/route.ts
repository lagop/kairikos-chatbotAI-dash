import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { encryptTotpSecret, generateTotpSecret, getTotpUri } from '@/lib/operator-crypto';
import {
  readLoginChallenge,
  emailCodeMatches,
  passwordFingerprint,
  signLoginChallenge,
  takeSecondFactorAttempt,
} from '@/lib/operator-login';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/operator/login/email-code — solo para un operador sin TOTP.
//
// Con el código que llegó a su email, empieza el alta del autenticador:
// devuelve el URI para escanear y un reto 'enroll_confirm'. El alta termina
// en /api/operator/login/totp con el primer código de la app, que es también
// el que abre la sesión. Ver src/lib/operator-login.ts.
// =============================================================================

const BodySchema = z.object({
  challenge: z.string().min(1),
  code: z.string().trim().min(1).max(16),
});

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const challenge = readLoginChallenge(body.data.challenge, 'email_code');
  if (!challenge) {
    return NextResponse.json({ error: 'challenge_expired' }, { status: 401 });
  }
  if (!takeSecondFactorAttempt(challenge.op)) {
    return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: challenge.op },
    select: { id: true, email: true, passwordHash: true, isActive: true, totpEnrolledAt: true },
  });
  if (!operator || !operator.isActive || passwordFingerprint(operator.passwordHash) !== challenge.pw) {
    return NextResponse.json({ error: 'challenge_expired' }, { status: 401 });
  }
  if (operator.totpEnrolledAt) {
    return NextResponse.json({ error: 'totp_already_enrolled' }, { status: 409 });
  }
  if (!emailCodeMatches(challenge, body.data.code)) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 401 });
  }

  const rawSecret = generateTotpSecret();
  await prisma.operator.update({
    where: { id: operator.id },
    data: { totpSecret: encryptTotpSecret(rawSecret), lastTotpAt: null },
  });

  const next = signLoginChallenge({ op: operator.id, st: 'enroll_confirm', pw: challenge.pw });
  if (!next) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  return NextResponse.json({
    step: 'enroll_confirm',
    challenge: next,
    uri: getTotpUri(rawSecret, operator.email),
    secret: rawSecret,
  });
}
