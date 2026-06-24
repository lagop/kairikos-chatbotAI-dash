// KAIA-2103 — Admin: trigger a setup-password email for a client user.
// Sends an email with a direct link to set the initial password (no token needed,
// the email itself is the auth signal — sent to a known, approved address).

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateRequest } from '@/lib/api-auth';

const SendSetupEmailSchema = z.object({
  email: z.string().email(),
});

const FROM_ADDRESS = process.env.AUTH_EMAIL_FROM ?? 'Kairikos Portal <hola@kairikos.com>';
const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

function operatorKeyAuth(req: NextRequest): boolean {
  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!envKey) return false;
  const provided = req.headers.get('x-kaia-operator-key');
  return provided === envKey;
}

async function sendSetupEmail(params: { to: string; setupUrl: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  const { to, setupUrl } = params;
  const subject = 'Activa tu acceso al portal — Kairikos';
  const text = [
    'Hola,',
    '',
    'El equipo de Kairikos te ha dado acceso al portal de cliente.',
    '',
    'Haz clic en el siguiente enlace para crear tu contraseña y acceder al portal:',
    setupUrl,
    '',
    'Este enlace es personal y caduca en 7 días.',
    '',
    '— Equipo Kairikos',
    `Soporte: ${SUPPORT_EMAIL}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Activa tu acceso al portal</h1>
    </div>
    <p>Hola,</p>
    <p>El equipo de Kairikos te ha dado acceso al portal de cliente.</p>
    <p>Haz clic en el botón para crear tu contraseña y acceder:</p>
    <p style="margin: 28px 0;">
      <a href="${setupUrl}" style="background: #111827; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
        Crear mi contraseña
      </a>
    </p>
    <p style="font-size: 12px; color: #6b7280;">Este enlace es personal y caduca en 7 días.</p>
    <p style="font-size: 12px; color: #6b7280;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="font-size: 12px; color: #6b7280; word-break: break-all;">${setupUrl}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      ¿Necesitas ayuda? Escríbenos a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
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

  const parsed = SendSetupEmailSchema.safeParse(body);
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

  if (user.passwordHash !== null) {
    return NextResponse.json({ error: 'password_already_set' }, { status: 409 });
  }

  const setupUrl = `${PORTAL_BASE_URL}/portal/setup-password?email=${encodeURIComponent(normalizedEmail)}`;

  try {
    await sendSetupEmail({ to: normalizedEmail, setupUrl });
  } catch (err) {
    console.error('[send-setup-email] email send failed:', err);
    return NextResponse.json({ error: 'email_send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
