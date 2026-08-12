// KAIA-2103 — Admin: trigger a password-reset email for a client user.
// The user must already have a password set; this flows through the same
// forgot-password token mechanism as the self-service flow.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { sendEmail, buildResetAdminEmailHtml } from '@/lib/auth-email';
import * as crypto from 'node:crypto';

const TriggerResetSchema = z.object({
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
    'El equipo de Kairikos ha solicitado un restablecimiento de contraseña para tu cuenta.',
    '',
    'Haz clic en el siguiente enlace para crear una nueva contraseña:',
    params.resetUrl,
    '',
    `Este enlace caduca en ${TOKEN_EXPIRY_HOURS} horas y solo puede usarse una vez.`,
    '',
    'Si no has solicitado esto, contacta con nosotros inmediatamente.',
    '',
    '— Equipo Kairikos',
  ].join('\n');

  await sendEmail({
    to: params.to,
    subject,
    text,
    html: buildResetAdminEmailHtml(params.resetUrl, TOKEN_EXPIRY_HOURS),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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

  const clientUser = await prisma.chatbotClientUser.findFirst({
    where: { nextAuthEmail: normalizedEmail, clientId },
    select: { id: true, userId: true },
  });

  if (!clientUser) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const user = clientUser.userId
    ? await prisma.user.findUnique({
        where: { id: clientUser.userId },
        select: { id: true, passwordHash: true },
      })
    : null;

  if (!user || !user.passwordHash) {
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
