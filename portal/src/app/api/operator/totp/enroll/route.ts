import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSessionCookieId, getValidSession, touchSession } from '@/lib/operator-session';
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  getTotpUri,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/operator-crypto';

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
  } catch {}
  const code = body?.code;

  const operator = await prisma.operator.findUnique({
    where: { id: session.operatorId },
    include: { recoveryCodes: true },
  });
  if (!operator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Phase 1: No code provided → generate secret and return URI
  if (!code) {
    if (operator.totpEnrolledAt) {
      return NextResponse.json({ error: 'totp_already_enrolled' }, { status: 409 });
    }

    const rawSecret = generateTotpSecret();
    const encrypted = encryptTotpSecret(rawSecret);

    await prisma.operator.update({
      where: { id: operator.id },
      data: { totpSecret: encrypted },
    });

    await touchSession(sessionId);

    return NextResponse.json({
      uri: getTotpUri(rawSecret, operator.email),
      step: 'scan',
    });
  }

  // Phase 2: Code provided → verify and finalize enrollment
  if (!operator.totpSecret) {
    return NextResponse.json({ error: 'enrollment_not_started' }, { status: 400 });
  }
  if (operator.totpEnrolledAt) {
    return NextResponse.json({ error: 'totp_already_enrolled' }, { status: 409 });
  }

  const rawSecret = decryptTotpSecret(operator.totpSecret);
  if (!verifyTotpCode(code, rawSecret)) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }

  const now = new Date();

  await prisma.operator.update({
    where: { id: operator.id },
    data: { totpEnrolledAt: now, lastTotpAt: now },
  });

  const plaintextCodes = generateRecoveryCodes(8);
  const hashedCodes = await Promise.all(plaintextCodes.map(hashRecoveryCode));

  await prisma.operatorRecoveryCode.createMany({
    data: hashedCodes.map((codeHash) => ({
      operatorId: operator.id,
      codeHash,
    })),
  });

  await touchSession(sessionId);

  return NextResponse.json({
    recoveryCodes: plaintextCodes,
    message: 'Store these recovery codes in a safe place. They will not be shown again.',
  });
}
