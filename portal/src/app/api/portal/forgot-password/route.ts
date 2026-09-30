// KAIA-2103 — Request a password reset for a client user.
// Generates a time-limited single-use token and sends the reset link via email.
//
// Revisión de seguridad del 30/09/2026 — dos agujeros que la versión del
// operador (api/operator/forgot-password) ya tenía cerrados y esta no:
//   - Sin límite de intentos. Cada llamada invalida el token anterior y manda
//     un correo: con un bucle se bombardeaba el buzón de un cliente y se
//     gastaba la cuota de Resend. Ahora, 20 por IP y 5 por correo cada 15 min.
//   - Revelaba si el correo existe: respondía 500 «email_send_failed» solo
//     cuando la cuenta existía y el envío fallaba. Ahora siempre {ok:true}; el
//     fallo se registra, que es donde tiene que verse.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sendEmail, buildPasswordResetHtml } from '@/lib/auth-email';
import * as crypto from 'node:crypto';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { logError } from '@/lib/observability';

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);
const emailRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const TOKEN_EXPIRY_HOURS = 2;
// `||` y no `??`: una variable declarada y vacía dejaría el enlace del correo
// sin dominio (trampa 4 de CLAUDE.md).
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://portal.kairikos.cloud';

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

  if (!ipRateLimiter.check(`ip:${clientIpFromHeaders(req.headers)}`, 20)) {
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

  const { email } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Mismo 429 exista o no la cuenta: el límite va por el correo que se pide,
  // no por el que hay en la base de datos.
  if (!emailRateLimiter.check(`email:${normalizedEmail}`, 5)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const clientUser = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: normalizedEmail },
    select: { id: true, userId: true },
  });

  if (!clientUser || !clientUser.userId) {
    return NextResponse.json({ ok: true });
  }

  const user = await prisma.user.findUnique({
    where: { id: clientUser.userId },
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
    // Sin el correo en el registro: el fallo es del envío, no de la persona.
    logError('forgot_password.email_failed', err, { route: 'api/portal/forgot-password' }, 'error');
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
