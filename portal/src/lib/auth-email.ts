// KAIA-2103 — Shared email-sending helpers for auth flows.
// Wraps the Resend API with consistent error handling.

import { Resend } from 'resend';

let _Resend: Resend | null = null;

function getResendClient(): Resend {
  if (_Resend) return _Resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  _Resend = new Resend(apiKey);
  return _Resend;
}

const FROM_ADDRESS = process.env.AUTH_EMAIL_FROM ?? 'Kairikos Portal <hola@kairikos.com>';
const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';

export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const resend = getResendClient();
  const result = await resend.emails.send({
    from: FROM_ADDRESS,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
}

export function buildPasswordResetHtml(resetUrl: string, expiryHours: number): string {
  return `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Restablece tu contraseña</h1>
    </div>
    <p>Hola,</p>
    <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta.</p>
    <p style="margin: 28px 0;">
      <a href="${resetUrl}" style="background: #111827; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
        Restablecer contraseña
      </a>
    </p>
    <p style="font-size: 12px; color: #6b7280;">Este enlace caduca en ${expiryHours} horas y solo puede usarse una vez.</p>
    <p style="font-size: 12px; color: #6b7280;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="font-size: 12px; color: #6b7280; word-break: break-all;">${resetUrl}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      ¿No has solicitado este restablecimiento? Puedes ignorar este mensaje.<br />
      ¿Necesitas ayuda? Escríbenos a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
    </p>
  </body>
</html>`;
}

export function buildSetupEmailHtml(setupUrl: string): string {
  return `<!doctype html>
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
}

export function buildResetAdminEmailHtml(resetUrl: string, expiryHours: number): string {
  return `<!doctype html>
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
    <p style="font-size: 12px; color: #6b7280;">Este enlace caduca en ${expiryHours} horas y solo puede usarse una vez.</p>
    <p style="font-size: 12px; color: #6b7280;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="font-size: 12px; color: #6b7280; word-break: break-all;">${resetUrl}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      ¿No has solicitado esto? Contacta con nosotros inmediatamente.<br />
      Escríbenos a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
    </p>
  </body>
</html>`;
}

export {
  FROM_ADDRESS,
  SUPPORT_EMAIL,
};
