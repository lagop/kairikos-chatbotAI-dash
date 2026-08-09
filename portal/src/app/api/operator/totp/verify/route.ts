import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSessionCookieId, getValidSession, markTotpVerified, touchSession } from '@/lib/operator-session';
import { decryptTotpSecret, verifyTotpCode, verifyRecoveryCode } from '@/lib/operator-crypto';

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

  let body: { code?: string } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { code } = body ?? {};
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: session.operatorId },
    include: { recoveryCodes: true },
  });
  if (!operator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (!operator.totpEnrolledAt || !operator.totpSecret) {
    return NextResponse.json({ error: 'totp_not_enrolled' }, { status: 400 });
  }

  const rawSecret = decryptTotpSecret(operator.totpSecret);
  const isTotpValid = verifyTotpCode(code, rawSecret);

  if (isTotpValid) {
    await markTotpVerified(sessionId);
    await prisma.operator.update({
      where: { id: operator.id },
      data: { lastTotpAt: new Date() },
    });
    await touchSession(sessionId);
    return NextResponse.json({ ok: true, method: 'totp' });
  }

  // Fallback: check recovery codes
  for (const rc of operator.recoveryCodes) {
    if (rc.consumedAt) continue;
    const valid = await verifyRecoveryCode(rc.codeHash, code);
    if (valid) {
      await prisma.operatorRecoveryCode.update({
        where: { id: rc.id },
        data: { consumedAt: new Date() },
      });
      await markTotpVerified(sessionId);
      await touchSession(sessionId);
      return NextResponse.json({ ok: true, method: 'recovery_code' });
    }
  }

  return NextResponse.json({ error: 'invalid_code' }, { status: 401 });
}
