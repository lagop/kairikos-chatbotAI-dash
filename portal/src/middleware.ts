import { NextResponse, type NextRequest } from 'next/server';

const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

export default function middleware(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const isDevMock =
    !supabaseUrl ||
    supabaseUrl.includes('YOUR-PROJECT') ||
    supabaseUrl === 'https://invalid.supabase.co';

  if (!isDevMock) {
    return NextResponse.next();
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (!req.cookies.get(DEV_SESSION_COOKIE)) {
    res.cookies.set(DEV_SESSION_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
  }
  if (!req.cookies.get(OPERATOR_COOKIE)) {
    res.cookies.set(OPERATOR_COOKIE, '1', {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
  }
  return res;
}

export const config = {
  matcher: ['/portal/:path*'],
};