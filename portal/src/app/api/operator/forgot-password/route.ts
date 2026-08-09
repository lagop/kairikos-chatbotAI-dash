// KAIA-12714 — Request a password reset for an operator (support/soporte) account.
//
// Mirrors the customer `/api/portal/forgot-password` route's contract
// (single-use token, sha256-hashed at rest, fail-closed on Resend rejection,
// silent `{ok:true}` on unknown email to prevent enumeration), but wired
// to the `Operator` Prisma model instead of `ChatbotClientUser` → `User`.
//
// The customer route is intentionally untouched — KAIA-12714 only adds the
// operator path. The `/admin/forgot-password` UI now posts to this route
// for operator emails (the operator session is gated by `kairikos_operator_session`,
// see `src/lib/operator-session.ts`).
//
// Failure semantics:
//   * Body validation fails       → 400 { error: 'invalid_body' }
//   * DB not configured           → 503 { error: 'service_unavailable' }
//   * Resend send fails           → 500 { error: 'email_send_failed' }
//     (the token row is invalidated before returning so a retry does not
//      silently succeed if Resend flakes)
//   * Operator unknown / inactive → 200 { ok: true }  (no enumeration)
//
// The plaintext token never leaves this function. Only the Resend email
// URL sees it, and only via the URL inside the email body.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sendEmail, buildPasswordResetHtml } from '@/lib/auth-email';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const TOKEN_EXPIRY_HOURS = 2;
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);
const emailRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const forwardedFor = req.headers.get('x-forwarded-for') ?? null;
  const ip = forwardedFor?.split(',')[0]?.trim() ?? '127.0.0.1';

  if (!ipRateLimiter.check(`ip:${ip}`, 20)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = ForgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const normalizedEmail = parsed.data.email.toLowerCase().trim();

  if (!emailRateLimiter.check(`email:${normalizedEmail}`, 5)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  // Look up the operator. No enumeration: silently return ok when unknown.
  const operator = await prisma.operator.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, isActive: true },
  });
  if (!operator || !operator.isActive) {
    return NextResponse.json({ ok: true });
  }

  // Invalidate any existing unused tokens for this email.
  await prisma.passwordResetToken.updateMany({
    where: { email: normalizedEmail, usedAt: null },
    data: { usedAt: new Date() },
  });

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { email: normalizedEmail, tokenHash: hash, expiresAt },
  });

  const resetUrl = `${PORTAL_BASE_URL}/admin/reset-password?token=${raw}&email=${encodeURIComponent(normalizedEmail)}`;

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'Restablece tu contraseña — Kairikos',
      text: [
        'Hola,',
        '',
        'Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en la vista de soporte de Kairikos.',
        '',
        'Haz clic en el siguiente enlace para crear una nueva contraseña:',
        resetUrl,
        '',
        `Este enlace caduca en ${TOKEN_EXPIRY_HOURS} horas y solo puede usarse una vez.`,
        '',
        'Si no has solicitado este restablecimiento, puedes ignorar este mensaje.',
        '',
        '— Equipo Kairikos',
      ].join('\n'),
      html: buildPasswordResetHtml(resetUrl, TOKEN_EXPIRY_HOURS),
    });
  } catch (err) {
    // Burn the token so a retry does not silently succeed.
    await prisma.passwordResetToken.updateMany({
      where: { email: normalizedEmail, usedAt: null, tokenHash: hash },
      data: { usedAt: new Date() },
    });
    console.error('[operator-forgot-password] email send failed:', err);
    return NextResponse.json({ error: 'email_send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}