import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { verifyPassword, InMemoryRateLimiter } from '@/lib/operator-crypto';
import { createSession, setSessionCookie } from '@/lib/operator-session';

const loginRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);
const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  let body: { email?: string; password?: string } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { email, password } = body ?? {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const forwardedFor = req.headers.get('x-forwarded-for') ?? null;
  const ip = forwardedFor?.split(',')[0]?.trim() ?? '127.0.0.1';
  const userAgent = req.headers.get('user-agent') ?? undefined;

  const emailKey = `email:${normalizedEmail}`;
  const ipKey = `ip:${ip}`;

  if (!ipRateLimiter.check(ipKey, 20)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }
  if (!loginRateLimiter.check(emailKey, 5)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const operator = await prisma.operator.findUnique({
    where: { email: normalizedEmail },
  });
  if (!operator || !operator.isActive) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const passwordOk = await verifyPassword(operator.passwordHash, password);
  if (!passwordOk) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  await prisma.operator.update({
    where: { id: operator.id },
    data: { lastLoginAt: new Date() },
  });

  const sessionId = await createSession(operator.id, ip, userAgent ?? null);

  const response = NextResponse.json({
    totpRequired: operator.totpEnrolledAt !== null,
  });
  const cookie = setSessionCookie(sessionId);
  response.cookies.set(cookie.name, cookie.value, cookie.options);

  return response;
}
