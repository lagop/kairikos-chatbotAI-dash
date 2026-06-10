// KAIA-753 — legacy magic-link POST endpoint.
//
// The end-client portal moved from Supabase Auth magic-link to
// NextAuth.js v5 + Resend. The actual signin flow now lives at
// /api/auth/signin/nodemailer (exposed by the NextAuth catch-all route).
//
// This handler is kept only as a backward-compatible shim: any caller that
// still POSTs `email=...` to /api/portal/login is redirected to the
// NextAuth signin endpoint. The old Supabase-magic-link behavior (signInWithOtp
// via @supabase/ssr) is intentionally NOT reproduced — the trust boundary
// moved to NextAuth and the Prisma `nextAuthEmail` mapping (plan rev 3).

import { NextResponse } from 'next/server';

const NEXT_AUTH_SIGNIN_PATH = '/api/auth/signin/nodemailer';

export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const next = String(form.get('next') ?? '/portal') || '/portal';
  const callbackUrl = next.startsWith('/') ? next : '/portal';

  if (!email || !email.includes('@')) {
    return NextResponse.redirect(new URL('/portal/login?error=email', req.url), 303);
  }

  // Two-step redirect: 303 to /api/auth/signin/nodemailer?email=...&callbackUrl=...
  // The NextAuth signin page POSTs the email and dispatches the magic link.
  const signinUrl = new URL(NEXT_AUTH_SIGNIN_PATH, req.url);
  signinUrl.searchParams.set('email', email);
  signinUrl.searchParams.set('callbackUrl', callbackUrl);
  return NextResponse.redirect(signinUrl, 303);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
