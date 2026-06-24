// KAIA-2103 — Admin: trigger a password-reset email for a client user.
// The user must already have a password set; this flows through the same
// forgot-password token mechanism as the self-service flow.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateRequest } from '@/lib/api-auth';
import * as crypto from 'node:crypto';

const TriggerResetSchema = z.object({
  email: z.string().email(),
});

const TOKEN_EXPIRY_HOURS = 2;
const FROM_ADDRESS = process.env.AUTH_EMAIL_FROM ?? 'Kairikos Portal <hola@kairikos.com>';
const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

function operatorKeyAuth(req: NextRequest): boolean {
  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!envKey) return false;
  const provided = req.headers.get('x-kaia-operator-key');
  return provided === envKey;
}

function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

async function sendResetEmail(params: { to: string; resetUrl: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  const { to, resetUrl } = params;
  const subject = 'Restablece tu contraseña — Kairikos';
  const text = [
    'Hola,',
    '',
    'El equipo de Kairikos ha solicitado un restablecimiento de contraseña para tu cuenta.',
    '',
    'Haz clic en el siguiente enlace para crear una nueva contraseña:',
    resetUrl,
    '',
    `Este enlace caduca en ${TOKEN_EXPIRY_HOURS} horas y solo puede usarse una vez.`,
    '',
    'Si no has solicitado esto, contacta con nosotros inmediatamente.',
    '',
    '— Equipo Kairikos',
    `Soporte: ${SUPPORT_EMAIL}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Restablece tu contraseña</h1>
    </div>
    <p>Hola,</p>
    <p>El equipo de Kairikos ha solicitado un restablecimiento de contraseña para tu cuenta.</p>
    <p style="margin: 28px 0;">
      <a href="${resetUrl}" style="background: #111827; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
        Restablecer contraseña
      </a>
    </p>
    <p style="font-size: 12px; color: #6b7280;">Este enlace caduca en ${TOKEN_EXPIRY_HOURS} horas y solo puede usarse una vez.</p>
    <p style="font-size: 12px; color: #6b7280;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="font-size: 12px; color: #6b7280; word-break: break-all;">${resetUrl}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      ¿No has solicitado esto? Contacta con nosotros inmediatamente.<br />
      Escríbenos a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
    </p>
  </body>
</html>`;

  const result = await resend.emails.send({ from: FROM_ADDRESS, to, subject, text, html });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const keyOk = operatorKeyAuth(req);
  if (!keyOk) {
    const auth = await authenticateRequest(req);
    if (!auth.ok || !auth.isOperator) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const clientId = params.id;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = TriggerResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { email } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.chatbotClientUser.findFirst({
    where: { nextAuthEmail: normalizedEmail, clientId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  if (!user.passwordHash) {
    return NextResponse.json({ error: 'password_not_set' }, { status: 409 });
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
    console.error('[trigger-password-reset] email send failed:', err);
    return NextResponse.json({ error: 'email_send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
