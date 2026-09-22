import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { verifyPassword, InMemoryRateLimiter } from '@/lib/operator-crypto';
import {
  isLoginChallengeConfigured,
  signLoginChallenge,
  passwordFingerprint,
  generateEmailCode,
  hashEmailCode,
} from '@/lib/operator-login';
import { sendOperatorEnrollmentCode } from '@/lib/auth-email';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/operator/login — primer paso de la entrada del operador.
//
// Solo comprueba la contraseña. NO crea sesión: devuelve un reto firmado
// para el segundo paso (ver src/lib/operator-login.ts).
//   - Operador con TOTP        → { step: 'totp' }        → /api/operator/login/totp
//   - Operador todavía sin él  → { step: 'email_code' }  → /api/operator/login/email-code
//     (se envía un código a su email: la contraseña sola no basta para
//     registrar un autenticador)
// =============================================================================

const loginRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);
const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

const BodySchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  if (!isLoginChallengeConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const normalizedEmail = body.data.email.toLowerCase();
  const ip = clientIpFromHeaders(req.headers);

  if (!ipRateLimiter.check(`ip:${ip}`, 20)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }
  if (!loginRateLimiter.check(`email:${normalizedEmail}`, 5)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const operator = await prisma.operator.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, passwordHash: true, isActive: true, totpEnrolledAt: true, totpSecret: true },
  });
  if (!operator || !operator.isActive || !operator.passwordHash || operator.passwordHash === '__must_reset__') {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }
  if (!(await verifyPassword(operator.passwordHash, body.data.password))) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const pw = passwordFingerprint(operator.passwordHash);

  if (operator.totpEnrolledAt && operator.totpSecret) {
    const challenge = signLoginChallenge({ op: operator.id, st: 'totp', pw });
    return NextResponse.json({ step: 'totp', challenge });
  }

  const code = generateEmailCode();
  const ec = hashEmailCode(operator.id, code);
  const challenge = ec ? signLoginChallenge({ op: operator.id, st: 'email_code', pw, ec }) : null;
  if (!challenge) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  try {
    await sendOperatorEnrollmentCode({ to: operator.email, code });
  } catch (err) {
    logError('operator_login.enrollment_code_send_failed', err, { operatorId: operator.id });
    return NextResponse.json({ error: 'email_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ step: 'email_code', challenge });
}
