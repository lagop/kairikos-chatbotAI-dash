import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSessionCookieId, getValidSession, markTotpVerified, touchSession } from '@/lib/operator-session';
import { verifySecondFactor } from '@/lib/operator-login';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/operator/totp/verify — el TOTP que piden las acciones sensibles
// (ver operator-totp-stepup.ts). Hasta el 22/09/2026 no limitaba intentos y
// aceptaba repetir un código ya usado; ahora pasa por la misma comprobación
// que la entrada, con el mismo contador de intentos (operator-login.ts).

const ERROR_STATUS = { too_many_attempts: 429, invalid_code: 401, totp_not_enrolled: 400 } as const;

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const sessionId = getSessionCookieId(req);
  if (!sessionId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const session = await getValidSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { code?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (typeof body?.code !== 'string' || !body.code) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: session.operatorId },
    include: { recoveryCodes: true },
  });
  if (!operator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!operator.totpEnrolledAt) {
    return NextResponse.json({ error: 'totp_not_enrolled' }, { status: 400 });
  }

  const result = await verifySecondFactor(prisma, operator, body.code, { allowRecoveryCode: true });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] });
  }
  await markTotpVerified(sessionId);
  await touchSession(sessionId);
  return NextResponse.json({ ok: true, method: result.method });
}
