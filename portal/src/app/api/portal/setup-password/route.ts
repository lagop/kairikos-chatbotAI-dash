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

const ALLOWED_DOMAIN = process.env.ALLOWED_SETUP_DOMAIN ?? 'kairikos.com';

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

  // Basic domain gate — reject corporate emails unless whitelisted.
  const domain = normalizedEmail.split('@')[1] ?? '';
  if (!ALLOWED_DOMAIN.split(',').map((d) => d.trim()).includes(domain)) {
    return NextResponse.json({ error: 'invalid_email_domain' }, { status: 400 });
  }

  const user = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    // Security: do not reveal whether the email exists.
    return NextResponse.json({ ok: true });
  }

  if (user.passwordHash !== null) {
    return NextResponse.json({ error: 'password_already_set' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.chatbotClientUser.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
