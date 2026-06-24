// KAIA-2103 — Reset password using a valid single-use token.
// The token is validated against the stored hash; the plaintext is never stored.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashPassword } from '@/lib/operator-crypto';
import * as crypto from 'node:crypto';

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

  const user = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.chatbotClientUser.update({
      where: { id: user.id },
      data: { passwordHash },
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
