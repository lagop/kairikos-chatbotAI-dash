// KAIA-2103 — Set the initial password for a client user whose passwordHash is NULL or `__must_reset__`.
//
// KAIA-11500 (security-critical follow-up to KAIA-11302 / KAIA-11329): the
// route MUST validate the `token` against `PasswordResetToken` before
// touching any user row, and the token row MUST be burned in the same
// transaction as the password write. The pre-KAIA-11500 build checked
// `User.passwordHash !== null` first and then wrote the password, which
// meant any 64-hex token in the body would silently set a real password
// hash — an authentication-bypass vector for anyone who knew a customer's
// email. QA confirmed the exploit live against
// `https://project-fxidg.vercel.app/api/portal/setup-password`
// (`orly.nityananda@gmail.com`, `token=0000…0000`, any 8+ char password
// returned `200 {"ok":true}` and authenticated successfully).
//
// The secure flow:
//
//   1. A `PasswordResetToken` row is minted server-side and the plaintext
//      token is delivered to the customer via the existing email channels
//      (admin `send-setup-email`, the `forgot-password` flow, or the
//      onboarding activation handler in `/api/onboarding/activate`).
//   2. The customer lands on `/portal/setup-password?email=...&token=...`
//      and POSTs the same `{email, token, password}` triple back here.
//   3. We hash the token, look up an unused, unexpired row, write the new
//      password, and burn the row in a single transaction. The plaintext
//      token is never stored.
//
// The `User.passwordHash` write is allowed when the existing value is
// `null` OR the `__must_reset__` sentinel (the backfill marker — see
// KAIA-11491). Any other value returns 409 `password_already_set` and
// the token is burned in the same request to neutralise replay.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashPassword } from '@/lib/operator-crypto';

const SetupPasswordSchema = z.object({
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

  const parsed = SetupPasswordSchema.safeParse(body);
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

  const clientUser = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, userId: true },
  });

  if (!clientUser || !clientUser.userId) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const user = await prisma.user.findUnique({
    where: { id: clientUser.userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  if (user.passwordHash !== null && user.passwordHash !== '__must_reset__') {
    // Burn the token anyway so a leaked link cannot be replayed against
    // a different (or the same) account.
    await prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    return NextResponse.json({ error: 'password_already_set' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordSetAt: new Date() },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
