// KAIA-2103 — Set initial password for a client user whose passwordHash is NULL.
// Called by the client after they receive an onboarding email with a setup link.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashPassword } from '@/lib/operator-crypto';

const SetupPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

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

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const clientUser = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, userId: true },
  });

  if (!clientUser || !clientUser.userId) {
    return NextResponse.json({ ok: true });
  }

  const user = await prisma.user.findUnique({
    where: { id: clientUser.userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    return NextResponse.json({ ok: true });
  }

  if (user.passwordHash !== null) {
    return NextResponse.json({ error: 'password_already_set' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, passwordSetAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
