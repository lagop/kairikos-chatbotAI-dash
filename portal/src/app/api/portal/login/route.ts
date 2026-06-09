import { NextResponse } from 'next/server';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const next = String(form.get('next') ?? '/portal') || '/portal';
  if (!email || !email.includes('@')) {
    return NextResponse.redirect(new URL('/portal/login?error=email', req.url), 303);
  }
  if (!isSupabaseConfigured) {
    const url = new URL('/portal/login', req.url);
    url.searchParams.set('sent', '1');
    url.searchParams.set('dev', '1');
    url.searchParams.set('email', email);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set('kairikos-portal-dev-session', '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return res;
  }
  const supabase = await createSupabaseServerClient();
  const redirectTo = new URL('/api/auth/callback', req.url);
  redirectTo.searchParams.set('next', next);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo.toString(),
      shouldCreateUser: false,
    },
  });
  if (error) {
    const url = new URL('/portal/login', req.url);
    url.searchParams.set('error', 'otp');
    url.searchParams.set('email', email);
    return NextResponse.redirect(url, 303);
  }
  const url = new URL('/portal/login', req.url);
  url.searchParams.set('sent', '1');
  url.searchParams.set('email', email);
  return NextResponse.redirect(url, 303);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
