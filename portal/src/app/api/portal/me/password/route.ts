// KAIA-3922 — Authenticated password change for the chatbot client.
//
// Flow:
//   1. Resolve the caller's session via NextAuth — refuse if unauthenticated.
//   2. Require the CURRENT password to be re-supplied and verified against
//      the stored argon2id hash. This is the reauthentication step the
//      issue calls out: an attacker who steals a session cookie must still
//      know the password to rotate it.
//   3. Hash the NEW password, update User.passwordHash + passwordSetAt,
//      and burn any open PasswordResetToken rows for the same email so a
//      concurrent reset flow cannot complete after the change.
//   4. Return { ok: true, reauth_required: true }. The client portal
//      runs NextAuth v5 with JWT sessions (no DB session table for client
//      users), so existing cookies cannot be revoked server-side. The
//      frontend signs the user out and forces a fresh login on the next
//      page. This matches the policy already documented in auth.ts:7-9.
//
// KAIA-4011 — dev-mock branch. When Supabase env vars signal a dev-mock
// build AND the caller is one of the dev-mock fixture emails, the route
// uses an in-memory password store keyed by email (deterministic
// `dev-old` initial, then whatever the caller rotates to) so the QA
// golden path can exercise the full rotation + forced re-login flow
// without a real Supabase row.
//
// Lens: blast radius — only the caller can rotate their own credential;
// MTTR — the response includes the re-auth signal so dashboards can flag
// stale tokens; separation of concerns — the route never echoes the new
// hash and never accepts a clientId from the body.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession, isPortalDevMock } from '@/lib/portal-session';
import { hashPassword, verifyPassword, InMemoryRateLimiter } from '@/lib/operator-crypto';
import { DEV_MOCK_CLIENT_BY_EMAIL } from '@/lib/portal-data';

const ChangePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Introduce tu contraseña actual.')
      .max(128, 'La contraseña actual es demasiado larga.'),
    newPassword: z
      .string()
      .min(8, 'La nueva contraseña debe tener al menos 8 caracteres.')
      .max(128, 'La nueva contraseña es demasiado larga (máximo 128 caracteres).'),
  })
  .strict();

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

// KAIA-4011 — in-memory password store for dev-mock rotations. Initial
// credential for every fixture is the deterministic `dev-old` so the
// QA Playwright spec can use a known value. The store lives only for
// the lifetime of the dev-mock preview process; restarts reset it.
const DEV_MOCK_INITIAL_PASSWORD = 'dev-old';
const devMockPasswords = new Map<string, string>();

function getDevMockPassword(email: string): string {
  const existing = devMockPasswords.get(email.toLowerCase());
  if (existing) return existing;
  devMockPasswords.set(email.toLowerCase(), DEV_MOCK_INITIAL_PASSWORD);
  return DEV_MOCK_INITIAL_PASSWORD;
}

function clientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  const ip = forwardedFor?.split(',')[0]?.trim();
  return ip || '127.0.0.1';
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured && !isPortalDevMock()) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  if (!ipRateLimiter.check(`portal-change-password:${clientIp(req)}`, 10)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'El cuerpo no es JSON válido.' },
      { status: 400 },
    );
  }

  const parsed = ChangePasswordSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => issue.message)
      .filter(Boolean)
      .join(' ');
    return NextResponse.json(
      { error: 'invalid_body', detail: detail || 'Cuerpo no válido.' },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword } = parsed.data;

  // KAIA-4011 — dev-mock branch. When the caller's email resolves to a
  // known dev-mock fixture AND we are running in dev-mock mode, exercise
  // the in-memory password store so the QA suite can run the full
  // rotation + forced re-login flow without a Supabase row.
  if (isPortalDevMock()) {
    const mockClient = DEV_MOCK_CLIENT_BY_EMAIL.get(resolved.email.toLowerCase());
    if (mockClient) {
      const current = getDevMockPassword(resolved.email);
      if (currentPassword !== current) {
        return NextResponse.json({ error: 'invalid_current_password' }, { status: 401 });
      }
      devMockPasswords.set(resolved.email.toLowerCase(), newPassword);
      return NextResponse.json({ ok: true, reauth_required: true });
    }
    if (!isDatabaseConfigured) {
      // Dev-mock caller with no fixture match and no DB → reject as
      // user_not_found so the spec surfaces the mismatch instead of
      // pretending the rotation succeeded.
      return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
    }
  }

  // Resolve the User row through the session email — never through a body
  // parameter. Cross-tenant attempts are impossible by construction because
  // resolveClientFromSession only ever returns the caller-own clientId.
  const clientUser = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: resolved.email.toLowerCase() },
    select: { id: true, userId: true },
  });

  if (!clientUser || !clientUser.userId) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const user = await prisma.user.findUnique({
    where: { id: clientUser.userId },
    select: { id: true, passwordHash: true, email: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  // Force the forgot-password flow for backfilled accounts that have not
  // yet chosen a credential. The setup-password route is the only entry
  // point that can write the first hash.
  if (!user.passwordHash || user.passwordHash === '__must_reset__') {
    return NextResponse.json({ error: 'must_complete_setup' }, { status: 409 });
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    return NextResponse.json({ error: 'invalid_current_password' }, { status: 401 });
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordSetAt: new Date() },
    }),
    // Defense in depth: any open reset token issued for this email must
    // not remain valid once the credential has rotated.
    prisma.passwordResetToken.updateMany({
      where: { email: user.email.toLowerCase(), usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  return NextResponse.json({ ok: true, reauth_required: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
