// KAIA-4011 — dev-mock session activator.
//
// In dev-mock mode (`isPortalDevMock()` true) the portal pages do not have
// a real Supabase auth flow, so the QA harness activates a mock session
// by setting three cookies: the active flag (`...-active`), the dev
// session marker (`kairikos-portal-dev-session`), and the dev-email
// (used by the profile page to switch tier). This route is the single
// place that writes those cookies so the contract is testable end-to-end:
//
//   curl -i -X POST -d 'email=qa-test-client-a@kairikos.com' \
//        https://preview.example/api/portal/dev-session
//
// In production (real Supabase env) the route refuses with 404 so it
// cannot be used to mint a session against a real deployment.

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { isPortalDevMock } from '@/lib/portal-session';
import { DEV_MOCK_CLIENT_BY_EMAIL } from '@/lib/portal-data';

const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const DEV_SESSION_ACTIVE_COOKIE = 'kairikos-portal-dev-session-active';
const DEV_EMAIL_COOKIE = 'kairikos-portal-dev-email';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, detail }, { status });
}

export async function POST(req: NextRequest) {
  if (!isPortalDevMock()) {
    return jsonError(404, 'not_found', 'Dev-mock session is only available in dev-mock environments.');
  }

  let email = '';
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const body = (await req.json()) as { email?: string };
      email = String(body?.email ?? '').trim().toLowerCase();
    } else {
      const form = await req.formData();
      email = String(form.get('email') ?? '').trim().toLowerCase();
    }
  } catch {
    return jsonError(400, 'invalid_body', 'El cuerpo no es JSON ni form-data válido.');
  }

  if (!email || !email.includes('@')) {
    return jsonError(400, 'invalid_email', 'Indica un email válido.');
  }

  const mock = DEV_MOCK_CLIENT_BY_EMAIL.get(email);
  if (!mock) {
    return jsonError(404, 'unknown_dev_mock_user', `No hay un cliente dev-mock para ${email}.`);
  }

  const jar = cookies();
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
  // Order matters for the middleware: the active flag must be present on
  // the next request for the dev session cookie to be (re)seeded.
  jar.set(DEV_SESSION_ACTIVE_COOKIE, '1', { ...cookieOptions, maxAge: 60 * 60 * 12 });
  jar.set(DEV_SESSION_COOKIE, '1', { ...cookieOptions, maxAge: 60 * 60 * 12 });
  jar.set(DEV_EMAIL_COOKIE, email, { ...cookieOptions, maxAge: 60 * 60 * 12 });
  // Operator cookie is non-httpOnly so client UI can read it.
  jar.set(OPERATOR_COOKIE, '1', {
    httpOnly: false,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  });

  return NextResponse.json({ ok: true, email, clientSlug: mock.slug });
}

// KAIA-4011 — explicit dev-mock logout: clears the active flag and the
// dev cookies. The matching layout redirect is the responsibility of the
// caller (Playwright `await page.goto('/portal/login')` or a manual
// `curl -i https://preview/portal/login`); the route itself never
// redirects so the QA harness can observe the 200 response.
export async function DELETE() {
  if (!isPortalDevMock()) {
    return jsonError(404, 'not_found', 'Dev-mock session is only available in dev-mock environments.');
  }
  const jar = cookies();
  jar.delete(DEV_SESSION_ACTIVE_COOKIE);
  jar.delete(DEV_SESSION_COOKIE);
  jar.delete(DEV_EMAIL_COOKIE);
  jar.delete(OPERATOR_COOKIE);
  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
