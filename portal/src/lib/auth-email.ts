// =============================================================================
// Resend magic-link sender (KAIA-753).
//
// Lives in its own file so the Next.js Edge runtime bundle (which the
// middleware pulls in via `auth.ts`) does not have to resolve the
// `resend` package's optional `@react-email/render` peer at build time.
// The middleware only reads `authConfig.callbacks.authorized` shape —
// the actual `sendVerificationRequest` is only invoked from the
// /api/auth/[...nextauth] route, which always runs on the Node runtime.
// =============================================================================

const FROM_ADDRESS = process.env.AUTH_EMAIL_FROM ?? 'Kairikos Portal <hola@kairikos.com>';
const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';
const SUPPORT_PHONE_WA = process.env.AUTH_SUPPORT_WHATSAPP ?? 'https://wa.me/34600000000';

export async function sendViaResend(params: {
  identifier: string;
  url: string;
  provider: { from?: string };
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Fail closed — never log the link to stdout (it would let any
    // operator with shell access on a misconfigured env sign in as any
    // user). The signIn callback in `auth.ts` rejects unknown emails,
    // so this path should be unreachable in production.
    throw new Error('RESEND_API_KEY is not configured');
  }
  // The `resend` SDK has an optional `@react-email/render` peer that
  // webpack tries to resolve at build time. The `auth.ts` import graph
  // is also pulled into the Edge runtime by middleware, so a static
  // `import 'resend'` would explode the Edge bundle. We use a runtime
  // `require` via a computed specifier — webpack's static analyser
  // cannot follow it, and the Node runtime resolves it at call time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);
  const { identifier, url, provider } = params;
  const from = provider.from ?? FROM_ADDRESS;
  const subject = 'Your Kairikos portal login link';
  const text = [
    'Hola,',
    '',
    'Haz clic en el siguiente enlace para acceder al portal de cliente de Kairikos:',
    url,
    '',
    'El enlace caduca en 24 horas y solo puede usarse una vez.',
    '',
    'Si no has solicitado este acceso, puedes ignorar este mensaje.',
    '',
    '— Equipo Kairikos',
    `Soporte: ${SUPPORT_EMAIL}`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Accede a tu portal</h1>
    </div>
    <p>Hola,</p>
    <p>Haz clic en el botón para iniciar sesión en el portal de cliente de Kairikos. El enlace caduca en 24 horas y solo puede usarse una vez.</p>
    <p style="margin: 28px 0;">
      <a href="${url}" style="background: #111827; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
        Acceder al portal
      </a>
    </p>
    <p style="font-size: 12px; color: #6b7280;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="font-size: 12px; color: #6b7280; word-break: break-all;">${url}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      ¿No has solicitado este acceso? Puedes ignorar este mensaje.<br />
      ¿Necesitas ayuda? Escríbenos a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> o
      <a href="${SUPPORT_PHONE_WA}">habla con nosotros por WhatsApp</a>.
    </p>
  </body>
</html>`;

  const result = await resend.emails.send({
    from,
    to: identifier,
    subject,
    text,
    html,
  });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
}
