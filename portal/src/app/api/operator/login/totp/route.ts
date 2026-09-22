import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/operator-crypto';
import { readLoginChallenge, passwordFingerprint, verifySecondFactor } from '@/lib/operator-login';
import { createSession, setSessionCookie } from '@/lib/operator-session';
import { clientIpFromHeaders } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/operator/login/totp — segundo paso de la entrada del operador.
//
// Con un reto 'totp': acepta el código de la app o uno de recuperación.
// Con un reto 'enroll_confirm': el primer código de la app recién dada de
// alta; termina el alta y devuelve los códigos de recuperación, que solo
// se ven esta vez.
// Solo aquí se crea la OperatorSession. Ver src/lib/operator-login.ts.
// =============================================================================

const BodySchema = z.object({
  challenge: z.string().min(1),
  code: z.string().trim().min(1).max(64),
});

const ERROR_STATUS = { too_many_attempts: 429, invalid_code: 401, totp_not_enrolled: 409 } as const;

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const loginChallenge = readLoginChallenge(body.data.challenge, 'totp');
  const enrollChallenge = loginChallenge ? null : readLoginChallenge(body.data.challenge, 'enroll_confirm');
  const challenge = loginChallenge ?? enrollChallenge;
  if (!challenge) {
    return NextResponse.json({ error: 'challenge_expired' }, { status: 401 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: challenge.op },
    include: { recoveryCodes: true },
  });
  if (!operator || !operator.isActive || passwordFingerprint(operator.passwordHash) !== challenge.pw) {
    return NextResponse.json({ error: 'challenge_expired' }, { status: 401 });
  }

  const enrolling = enrollChallenge !== null;
  if (enrolling ? operator.totpEnrolledAt !== null : operator.totpEnrolledAt === null) {
    return NextResponse.json({ error: 'challenge_expired' }, { status: 401 });
  }

  const result = await verifySecondFactor(prisma, operator, body.data.code, { allowRecoveryCode: !enrolling });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] });
  }

  const now = new Date();
  let recoveryCodes: string[] | undefined;
  if (enrolling) {
    recoveryCodes = generateRecoveryCodes(8);
    const hashed = await Promise.all(recoveryCodes.map(hashRecoveryCode));
    await prisma.$transaction([
      prisma.operatorRecoveryCode.deleteMany({ where: { operatorId: operator.id } }),
      prisma.operatorRecoveryCode.createMany({ data: hashed.map((codeHash) => ({ operatorId: operator.id, codeHash })) }),
      prisma.operator.update({ where: { id: operator.id }, data: { totpEnrolledAt: now } }),
    ]);
  }
  await prisma.operator.update({ where: { id: operator.id }, data: { lastLoginAt: now } });

  const sessionId = await createSession(
    operator.id,
    clientIpFromHeaders(req.headers),
    req.headers.get('user-agent'),
  );
  const response = NextResponse.json({ ok: true, method: result.method, ...(recoveryCodes ? { recoveryCodes } : {}) });
  const cookie = setSessionCookie(sessionId);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
