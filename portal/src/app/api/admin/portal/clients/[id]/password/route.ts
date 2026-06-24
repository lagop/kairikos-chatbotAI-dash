// KAIA-2103 — Admin: set or reset password for a client user.
// Operator-only; requires valid operator session or x-kaia-operator-key header.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateRequest } from '@/lib/api-auth';
import { hashPassword, constantTimeEqual, InMemoryRateLimiter } from '@/lib/operator-crypto';

const SetPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

function operatorKeyAuth(req: NextRequest): boolean {
  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!envKey) return false;
  const provided = req.headers.get('x-kaia-operator-key');
  if (!provided) return false;
  return constantTimeEqual(provided, envKey);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const keyOk = operatorKeyAuth(req);
  if (!keyOk) {
    const auth = await authenticateRequest(req);
    if (!auth.ok || !auth.isOperator) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const forwardedFor = req.headers.get('x-forwarded-for') ?? null;
  const ip = forwardedFor?.split(',')[0]?.trim() ?? '127.0.0.1';
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

  const user = await prisma.chatbotClientUser.findFirst({
    where: { nextAuthEmail: normalizedEmail, clientId },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.chatbotClientUser.update({
    where: { id: user.id },
    data: { passwordHash, passwordSetAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
