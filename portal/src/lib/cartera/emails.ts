import 'server-only';
import { notifyFromAddress } from '@/lib/email-sender';
import { portalBaseUrl } from '@/lib/portal-base-url';

// =============================================================================
// Cartera — los correos de la publicación (PR 4). Una publicación fallida
// avisa a la agencia y a Kairikos; la web anterior sigue en pie.
//
// Mismo molde que lib/villas/emails.ts: SDK de Resend con `await import`
// (nunca `(0, eval)('require')`, ver CLAUDE.md), remitente de
// notifyFromAddress(), nunca lanza, degrada sin RESEND_API_KEY. Y la trampa
// nº 4: una suite verde no dice si el correo sale; eso se prueba mandando uno
// desde producción.
//
// A la agencia, sin el enlace de la ejecución (es de un repositorio privado
// suyo que no puede abrir) ni jerga: qué pasó, que su web sigue como estaba y
// que Kairikos ya lo sabe. A Kairikos, todo lo que hace falta para mirarlo.
// =============================================================================

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
}

export interface FailedBuildInfo {
  siteUrl: string | null;
  githubRepo: string | null;
  buildId: string;
  trigger: string;
  stage: string | null;
  error: string | null;
  runUrl: string | null;
  clientId: string;
}

export function renderAgencyFailedEmail(info: FailedBuildInfo): RenderedEmail {
  const web = info.siteUrl ?? 'tu web';
  const paragraphs = [
    `La última publicación de tus casas en ${web} no ha salido.`,
    'Tu web sigue como estaba antes: no se ha quitado ni roto nada, solo faltan los últimos cambios.',
    info.stage === 'construir'
      ? 'Ha fallado al preparar la web. Lo más habitual es una casa con algún dato que la web no acepta; revisa los avisos en la pestaña Casas.'
      : 'Ha fallado al subirla al servidor.',
    'Kairikos ya está avisado y lo está mirando. En cuanto se arregle, tus cambios se publicarán solos.',
    `Tu panel: ${portalBaseUrl()}/portal/cartera`,
  ];
  return { subject: 'Tu web no se ha podido actualizar', text: paragraphs.join('\n\n'), html: toHtml(paragraphs) };
}

export function renderOperatorFailedEmail(info: FailedBuildInfo): RenderedEmail {
  const lines = [
    `Publicación de cartera fallida (${info.stage ?? 'sin fase'}).`,
    `Cliente: ${info.clientId}`,
    `Web: ${info.siteUrl ?? '—'}`,
    `Repositorio: ${info.githubRepo ?? '—'}`,
    `Publicación: ${info.buildId} (${info.trigger})`,
    `Ejecución: ${info.runUrl ?? '— (no llegó a lanzarse)'}`,
    info.error ? `Error: ${info.error}` : '',
    'La web anterior sigue en pie. A la agencia ya se le ha avisado.',
  ].filter(Boolean);
  return { subject: `Cartera: publicación fallida en ${info.siteUrl ?? info.githubRepo ?? info.clientId}`, text: lines.join('\n'), html: toHtml(lines) };
}

export type SendResult = { ok: true; messageId: string } | { ok: true; skipped: true; reason: 'no_api_key' | 'no_recipient' } | { ok: false; error: string };

export async function sendCarteraEmail(to: string | null | undefined, email: RenderedEmail): Promise<SendResult> {
  if (!to || !to.includes('@')) return { ok: true, skipped: true, reason: 'no_recipient' };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: true, skipped: true, reason: 'no_api_key' };
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({ from: notifyFromAddress(), to: [to], ...email });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send_failed' };
  }
}
