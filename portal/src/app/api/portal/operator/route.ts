import { NextResponse, type NextRequest } from 'next/server';

const OPERATOR_COOKIE = 'kairikos-portal-operator';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const mode = String(form.get('mode') ?? '');
  const target = String(form.get('return_to') ?? '/admin/portal/clients');
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  if (mode === 'enable') {
    res.cookies.set(OPERATOR_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
  } else if (mode === 'disable') {
    res.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
  }
  return res;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
