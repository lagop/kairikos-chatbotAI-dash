// KAIA-2103 — Request a password reset for a client user.
// Generates a time-limited single-use token and sends the reset link via email.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sendEmail, buildPasswordResetHtml } from '@/lib/auth-email';
import * as crypto from 'node:crypto';

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const TOKEN_EXPIRY_HOURS = 2;
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

async function sendResetEmail(params: { to: string; resetUrl: string }): Promise<void> {
  const subject = 'Restablece tu contraseña — Kairikos';
  const text = [
    'Hola,',
    '',
    'Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en el portal de Kairikos.',
    '',
    'Haz clic en el siguiente enlace para crear una nueva contraseña:',
    params.resetUrl,
    '',
    `Este enlace caduca en ${TOKEN_EXPIRY_HOURS} horas y solo puede usarse una vez.`,
    '',
    'Si no has solicitado este restablecimiento, puedes ignorar este mensaje.',
    '',
    '— Equipo Kairikos',
  ].join('\n');

  await sendEmail({
    to: params.to,
    subject,
    text,
    html: buildPasswordResetHtml(params.resetUrl, TOKEN_EXPIRY_HOURS),
  });
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
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

  const { email } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, passwordHash: true },
  });

  // Security: always return ok even if the email doesn't exist.
  if (!user || !user.passwordHash) {
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

  const resetUrl = `${PORTAL_BASE_URL}/portal/reset-password?token=${raw}&email=${encodeURIComponent(normalizedEmail)}`;

  try {
    await sendResetEmail({ to: normalizedEmail, resetUrl });
  } catch (err) {
    console.error('[forgot-password] email send failed:', err);
    return NextResponse.json({ error: 'email_send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
