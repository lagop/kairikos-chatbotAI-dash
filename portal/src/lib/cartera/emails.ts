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

/**
 * Las URL de un texto ya escapado, como enlaces. Hasta el 20/11/2026 iban como
 * texto: algunos clientes de correo no las enlazan solos, y el propietario las
 * vio sin poder pulsarlas en los primeros correos de producción. Aquí todo el
 * texto lo escribe el portal (el panel, la web que pone el operador, la
 * ejecución de GitHub), así que enlazar cualquier http(s) es seguro. En el
 * aviso de contacto, que lleva lo que escribió el comprador, solo se enlaza lo
 * que monta el portal (enquiry-rules.ts).
 */
export function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<>"]+/g, (raw) => {
    const url = raw.replace(/[.,;:!?)]+$/, '');
    return `<a href="${url}">${url}</a>${raw.slice(url.length)}`;
  });
}

function toHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${linkify(escapeHtml(p))}</p>`).join('\n');
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

export interface OwnerExitInfo {
  agencyName: string;
  siteUrl: string | null;
  graceEndsAt: Date;
  homeCount: number;
  enquiryCount: number;
}

/** El aviso de baja a la agencia (PR 6), una sola vez: cuánto tiempo tiene,
 *  qué deja de funcionar ya y dónde descargar. La fecha, en hora de Madrid. */
export function renderOwnerExitEmail(info: OwnerExitInfo): RenderedEmail {
  const deadline = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(info.graceEndsAt);
  const web = info.siteUrl ?? 'tu web';
  const paragraphs = [
    `Hola, ${info.agencyName}:`,
    'El servicio de cartera de tu web se ha dado de baja.',
    `Tus ${info.homeCount} casas, sus fotos y los ${info.enquiryCount} contactos que llegaron desde la web siguen guardados en el portal, en solo lectura, hasta el ${deadline} (hora peninsular). Ese día se borran del todo y no se pueden recuperar.`,
    `Antes de esa fecha, descarga el ZIP desde la pestaña Exportar: lleva las casas en el formato que entiende ${web}, para que quien mantenga la web pueda seguir sin el portal, los borradores y los contactos en un CSV.`,
    'Desde hoy la web ya no recibe casas nuevas del portal ni los formularios de contacto llegan aquí. Lo que ya estaba publicado sigue en la web hasta que se vuelva a construir.',
    'Si es un error o quieres volver, escríbenos antes de esa fecha y se reactiva tal cual.',
    `Tu panel: ${portalBaseUrl()}/portal/cartera`,
  ];
  const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' }).format(info.graceEndsAt);
  return { subject: `Tu cartera se borra el ${day}: descarga tus casas antes`, text: paragraphs.join('\n\n'), html: toHtml(paragraphs) };
}

export type SendResult = { ok: true; messageId: string } | { ok: true; skipped: true; reason: 'no_api_key' | 'no_recipient' } | { ok: false; error: string };

/** El remitente de Kairikos con otro nombre a la vista (el de la agencia, en
 *  los correos al comprador): «Agencia X <ops@kairikos.com>». */
export function fromWithName(name: string): string {
  const base = notifyFromAddress();
  const address = /<([^>]+)>/.exec(base)?.[1] ?? base;
  // eslint-disable-next-line no-control-regex
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean ? `${clean} <${address}>` : base;
}

export async function sendCarteraEmail(to: string | null | undefined, email: RenderedEmail, opts: { from?: string; replyTo?: string | null } = {}): Promise<SendResult> {
  if (!to || !to.includes('@')) return { ok: true, skipped: true, reason: 'no_recipient' };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: true, skipped: true, reason: 'no_api_key' };
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: opts.from ?? notifyFromAddress(),
      to: [to],
      ...(opts.replyTo && opts.replyTo.includes('@') ? { replyTo: opts.replyTo } : {}),
      ...email,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send_failed' };
  }
}
