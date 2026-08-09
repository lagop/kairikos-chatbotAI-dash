import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookieId, revokeSession, clearSessionCookie } from '@/lib/operator-session';

export async function POST(req: NextRequest) {
  const sessionId = getSessionCookieId(req);
  if (sessionId) {
    await revokeSession(sessionId);
  }
  const response = NextResponse.json({ ok: true });
  const cookie = clearSessionCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
