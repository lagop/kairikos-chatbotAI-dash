// KAIA-2103 — Admin: set or reset password for a client user.
// Operator-only; requires a valid operator session (la cabecera x-kaia-operator-key se retiró el 22/09/2026).

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { hashPassword, InMemoryRateLimiter } from '@/lib/operator-crypto';

const SetPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // Seguridad (22/09/2026): poner la contraseña de un cliente es entrar en
  // su cuenta. Pide TOTP reciente, no solo sesión.
  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const ip = clientIpFromHeaders(req.headers);
  if (!ipRateLimiter.check(`admin-password:${ip}`, 20)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const clientId = params.id;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = SetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const clientUser = await prisma.chatbotClientUser.findFirst({
    where: { nextAuthEmail: normalizedEmail, clientId },
    select: { id: true, userId: true },
  });

  if (!clientUser || !clientUser.userId) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.update({
    where: { id: clientUser.userId },
    data: { passwordHash, passwordSetAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
