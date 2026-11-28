import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { localDateFor, localMinutesFor } from './recall-digest';
import { localMonthFor, monthLabel, previousLocalMonth, shiftLocalMonth } from './local-month';
import { WEB_CARE_PRODUCT_CODE } from './custom-care-rules';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';
import { WEB_ACCESSIBLE_STATUSES } from './client-product-access';
import { notifyFromAddress } from './email-sender';
import { portalBaseUrl } from './portal-base-url';
import { logError } from './observability';
import { WEB_RESULTS_TIMEZONE } from './web-events-rules';

// =============================================================================
// Informe mensual de resultados de la web Premium (28/11/2026).
//
// Una vez al mes, el cliente con Cuidado Premium recibe lo que su web produjo
// el mes anterior —llamadas, WhatsApp, emails, formularios, reservas, chats y
// visitas desde buscadores con IA— comparado con el mes de antes. Es lo que
// justifica los 129 €/mes: el mismo argumento que el informe de llamadas
// (recall-reports.ts) y el semanal de valor (client-value-report.ts). Un
// cliente que no ve qué le da su web se pregunta para qué paga.
//
// Lo que NO hace: convertir clics en euros ni en pacientes. Un toque en
// «Llamar» es una intención, no una cita; el correo lo dice así. Mejor un
// número cierto que uno grande (la misma regla de client-value-report.ts).
//
// computeWebResults lo comparten el correo y el panel del cliente, a
// propósito: dos consultas distintas para «formularios de noviembre» acaban
// enseñando dos cifras distintas delante del cliente.
//
// Los datos de la web salen de web_event_day (la ruta pública
// /api/public/web-events/[token]); el chat y las llamadas, de las tablas de
// siempre, buscando los productos del cliente que cuelgan de ESTE sitio.
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

/** Hora local de Canarias a partir de la cual sale el informe del día 1. */
export const RESULTS_REPORT_HOUR = 9;
/** Si el scheduler estuvo caído el día 1, el 2 y el 3 aún lo mandan. Más
 *  tarde no: un informe de octubre a mitad de noviembre ya no se lee. */
export const RESULTS_REPORT_LAST_DAY = 3;

export interface WebResults {
  /** Llegadas a la web (todos los orígenes). */
  visitas: number;
  /** Llegadas desde ChatGPT, Perplexity, Claude, Gemini o Copilot. */
  visitasIa: number;
  /** Toques en el enlace de teléfono. Intenciones de llamar, no llamadas. */
  llamadasClic: number;
  whatsapp: number;
  emails: number;
  /** form_submit + booking_submit; los dos por separado debajo. */
  formularios: number;
  formulariosContacto: number;
  reservas: number;
  /** La cifra que se enseña: las conversaciones del chatbot del portal si el
   *  sitio tiene uno, y si no, los chat_start que mandó la web. */
  chats: number;
  /** chat_start recibidos de la web. */
  chatsWeb: number;
  /** ChatbotConversation del chatbot de este sitio; null si no tiene chatbot. */
  conversaciones: number | null;
  /** Llamadas perdidas que Modo Recado recuperó (sin las bloqueadas). */
  llamadasRecuperadas: number;
}

export function emptyWebResults(): WebResults {
  return {
    visitas: 0,
    visitasIa: 0,
    llamadasClic: 0,
    whatsapp: 0,
    emails: 0,
    formularios: 0,
    formulariosContacto: 0,
    reservas: 0,
    chats: 0,
    chatsWeb: 0,
    conversaciones: null,
    llamadasRecuperadas: 0,
  };
}

/** Lo que encabeza el correo: toda forma de ponerse en contacto desde la web. */
export function contactosDe(r: WebResults): number {
  return r.llamadasClic + r.whatsapp + r.emails + r.formularios;
}

export function hasAnyActivity(r: WebResults): boolean {
  return r.visitas + contactosDe(r) + r.chats + r.chatsWeb + (r.conversaciones ?? 0) + r.llamadasRecuperadas > 0;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/** El instante UTC de la medianoche local de un 'YYYY-MM-DD'. */
function localMidnightUtc(day: string, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const probe = new Date(utc);
  // Cuánto adelanta el reloj local a UTC en ese momento, entre −12 y +14 h.
  let offset = localMinutesFor(probe, timezone) - (probe.getUTCHours() * 60 + probe.getUTCMinutes());
  if (offset > 14 * 60) offset -= 24 * 60;
  return new Date(utc - offset * 60 * 1000);
}

/**
 * Los límites de un mes local: los instantes (para conversaciones y
 * llamadas) y los días (para web_event_day).
 *
 * No reutiliza monthBounds de recall-reports a propósito: aquel aplica a los
 * dos extremos el desfase del día 1, que yerra una hora en el mes del cambio
 * de hora. Para un total de llamadas da igual; aquí, con una columna DATE, el
 * fin de octubre caía el 31 a las 23:00 y se perdía el último día entero.
 * Cada extremo lleva su propio desfase.
 */
export function monthRange(localMonth: string, timezone: string = WEB_RESULTS_TIMEZONE): { since: Date; until: Date } {
  return {
    since: localMidnightUtc(`${localMonth}-01`, timezone),
    until: localMidnightUtc(`${shiftLocalMonth(localMonth, 1)}-01`, timezone),
  };
}

/** 'YYYY-MM-DD' a la Date que Prisma espera para una columna @db.Date. */
function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * ¿Toca el informe del mes pasado?
 *
 * El día 1 desde las 09:00 de Canarias, con margen hasta el día 3 por si el
 * scheduler estuvo caído. El cursor se compara por MES, como isReportDue de
 * recall-reports: un tick cada cinco minutos produce un solo correo.
 */
export function isResultsReportDue(now: Date, lastAt: Date | null): boolean {
  const today = localDateFor(now, WEB_RESULTS_TIMEZONE);
  const day = Number(today.slice(8, 10));
  if (day > RESULTS_REPORT_LAST_DAY) return false;
  if (day === 1 && localMinutesFor(now, WEB_RESULTS_TIMEZONE) < RESULTS_REPORT_HOUR * 60) return false;
  if (!lastAt) return true;
  return localMonthFor(lastAt, WEB_RESULTS_TIMEZONE) < localMonthFor(now, WEB_RESULTS_TIMEZONE);
}

// ---------------------------------------------------------------------------
// Las cifras
// ---------------------------------------------------------------------------

/**
 * Lo que la web de un sitio produjo entre `from` y `to` (instantes; usa
 * monthRange para un mes). Los contadores diarios se toman por día local:
 * desde el día de `from` hasta el día del último instante antes de `to`, así
 * que `to = ahora` incluye hoy y `to = medianoche del día 1` no incluye ese día.
 */
export async function computeWebResults(
  db: Db,
  clientSiteId: string,
  from: Date,
  to: Date,
): Promise<WebResults> {
  const results = emptyWebResults();
  const site = await db.clientSite.findUnique({
    where: { id: clientSiteId },
    select: { id: true, clientId: true, isPrimary: true },
  });
  if (!site) return results;

  const fromDay = localDateFor(from, WEB_RESULTS_TIMEZONE);
  const lastDay = localDateFor(new Date(to.getTime() - 1), WEB_RESULTS_TIMEZONE);

  // Los productos de ESTE sitio. Una contratación sin sitio declarado es del
  // primario (resolveContractedInstance), así que el primario se las lleva.
  const siteMatch: Prisma.ClientProductWhereInput[] = site.isPrimary
    ? [{ clientSiteId: site.id }, { clientSiteId: null, clientId: site.clientId }]
    : [{ clientSiteId: site.id }];

  const [groups, chatbotProducts, calls] = await Promise.all([
    db.webEventDay.groupBy({
      by: ['kind', 'source'],
      where: { clientSiteId: site.id, day: { gte: dateOnly(fromDay), lte: dateOnly(lastDay) } },
      _sum: { count: true },
    }),
    db.clientProduct.count({ where: { product: { code: CHATBOT_PRODUCT_CODE }, OR: siteMatch } }),
    db.callEvent.count({
      where: {
        startedAt: { gte: from, lt: to },
        // Las bloqueadas no llegaron ni al saludo: contarlas inflaría la
        // única cifra que el cliente mira (mismo criterio que recall-reports).
        outcome: { not: 'blocked' },
        subscription: { clientProduct: { OR: siteMatch } },
      },
    }),
  ]);

  for (const g of groups) {
    const n = g._sum.count ?? 0;
    switch (g.kind) {
      case 'landing':
        results.visitas += n;
        if (g.source === 'ai') results.visitasIa += n;
        break;
      case 'call_click':
        results.llamadasClic += n;
        break;
      case 'whatsapp_click':
        results.whatsapp += n;
        break;
      case 'email_click':
        results.emails += n;
        break;
      case 'form_submit':
        results.formulariosContacto += n;
        break;
      case 'booking_submit':
        results.reservas += n;
        break;
      case 'chat_start':
        results.chatsWeb += n;
        break;
      default:
        break;
    }
  }
  results.formularios = results.formulariosContacto + results.reservas;
  results.llamadasRecuperadas = calls;

  // Con chatbot del portal, sus conversaciones son la cifra de verdad: el
  // chat_start de la web cuenta también a quien abre el chat y no escribe.
  if (chatbotProducts > 0) {
    results.conversaciones = await db.chatbotConversation.count({
      where: {
        startedAt: { gte: from, lt: to },
        clientProduct: { product: { code: CHATBOT_PRODUCT_CODE }, OR: siteMatch },
      },
    });
    results.chats = results.conversaciones;
  } else {
    results.chats = results.chatsWeb;
  }

  return results;
}

/** Lo que pinta el panel (WebResultsCard). Sin token no hay cifras que
 *  enseñar, y el token no se le enseña al cliente: es cosa del operador. */
export type WebResultsPanelData =
  | { measuring: false }
  | {
      measuring: true;
      lastMonthLabel: string;
      currentMonthLabel: string;
      lastMonth: WebResults;
      monthBefore: WebResults;
      currentMonth: WebResults;
    };

/**
 * Las cifras del panel de una web: el último mes completo, el anterior (para
 * el cambio) y lo que va del actual. `clientSiteId` null = la web no declara
 * sitio, así que es la del sitio primario del cliente.
 */
export async function loadWebResultsPanel(
  db: Db,
  input: { clientId: string; clientSiteId: string | null },
  now: Date = new Date(),
): Promise<WebResultsPanelData> {
  const site = await db.clientSite.findFirst({
    where: input.clientSiteId
      ? { id: input.clientSiteId, clientId: input.clientId }
      : { clientId: input.clientId, isPrimary: true },
    select: { id: true, eventsToken: true },
  });
  if (!site?.eventsToken) return { measuring: false };

  const currentMonth = localMonthFor(now, WEB_RESULTS_TIMEZONE);
  const lastMonth = shiftLocalMonth(currentMonth, -1);
  const monthBefore = shiftLocalMonth(currentMonth, -2);
  const ranges = [monthRange(lastMonth), monthRange(monthBefore), monthRange(currentMonth)];
  const [last, before, current] = await Promise.all(
    ranges.map((r) => computeWebResults(db, site.id, r.since, r.until)),
  );
  return {
    measuring: true,
    lastMonthLabel: monthLabel(lastMonth),
    currentMonthLabel: monthLabel(currentMonth),
    lastMonth: last,
    monthBefore: before,
    currentMonth: current,
  };
}

// ---------------------------------------------------------------------------
// El correo
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-ES');

function n(value: number): string {
  return NUMBER.format(value);
}

/** «▲ 3 (+25 %)», «▼ 2 (−10 %)», «= sin cambios». Sin porcentaje cuando el
 *  mes anterior fue 0: un «+∞ %» no le dice nada a nadie. */
export function formatChange(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return '= sin cambios';
  const arrow = diff > 0 ? '▲' : '▼';
  const abs = n(Math.abs(diff));
  if (previous === 0) return `${arrow} ${abs}`;
  const pct = Math.round((Math.abs(diff) / previous) * 100);
  if (pct === 0) return `${arrow} ${abs}`;
  return `${arrow} ${abs} (${diff > 0 ? '+' : '−'}${pct} %)`;
}

type MetricKey =
  | 'llamadasClic'
  | 'whatsapp'
  | 'emails'
  | 'formularios'
  | 'chats'
  | 'llamadasRecuperadas'
  | 'visitas'
  | 'visitasIa';

/** Las filas del informe, en el orden en que se leen. Las comparte el panel
 *  (WebResultsCard) para que el correo y la pantalla digan lo mismo. */
export const WEB_RESULT_ROWS: ReadonlyArray<{ key: MetricKey; label: string; hint: string }> = [
  { key: 'llamadasClic', label: 'Llamadas desde la web', hint: 'Toques en el botón de llamar.' },
  { key: 'whatsapp', label: 'WhatsApp', hint: 'Toques en el botón de WhatsApp.' },
  { key: 'emails', label: 'Emails', hint: 'Toques en la dirección de email.' },
  { key: 'formularios', label: 'Formularios y reservas', hint: 'Formularios de contacto y solicitudes de reserva enviados.' },
  { key: 'chats', label: 'Conversaciones en el chat', hint: 'Conversaciones con el asistente de la web.' },
  { key: 'llamadasRecuperadas', label: 'Llamadas perdidas recuperadas', hint: 'Llamadas que no pudiste coger y atendió Modo Recado.' },
  { key: 'visitas', label: 'Visitas', hint: 'Llegadas a la web desde cualquier sitio.' },
  {
    key: 'visitasIa',
    label: 'Visitas desde buscadores con IA',
    hint: 'Personas que preguntaron a ChatGPT, Perplexity, Claude, Gemini o Copilot y llegaron a tu web desde la respuesta.',
  },
];

const SUBJECT_PARTS: ReadonlyArray<{ key: MetricKey; one: string; many: string }> = [
  { key: 'llamadasClic', one: 'llamada', many: 'llamadas' },
  { key: 'whatsapp', one: 'WhatsApp', many: 'WhatsApp' },
  { key: 'formularios', one: 'formulario', many: 'formularios' },
  { key: 'emails', one: 'email', many: 'emails' },
  { key: 'chats', one: 'conversación', many: 'conversaciones' },
  { key: 'llamadasRecuperadas', one: 'llamada recuperada', many: 'llamadas recuperadas' },
  { key: 'visitas', one: 'visita', many: 'visitas' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface WebResultsEmailInput {
  siteName: string;
  /** 'noviembre': el mes del informe. */
  monthLabel: string;
  /** 'octubre': el mes con el que se compara. Opcional por comodidad. */
  previousMonthLabel?: string;
  current: WebResults;
  previous: WebResults;
  panelUrl: string;
}

/** Puro: de las cifras al correo, para poder probar el texto sin red. */
export function buildWebResultsEmail(input: WebResultsEmailInput): { subject: string; text: string; html: string } {
  const { current, previous } = input;
  const comparedWith = input.previousMonthLabel ? `con ${input.previousMonthLabel}` : 'con el mes anterior';

  // El asunto: las tres primeras cifras que no sean cero, en orden de
  // importancia para un negocio (contactos antes que visitas).
  const subjectParts = SUBJECT_PARTS.filter((p) => current[p.key] > 0)
    .slice(0, 3)
    .map((p) => `${n(current[p.key])} ${current[p.key] === 1 ? p.one : p.many}`);
  const subject = subjectParts.length > 0
    ? `Tu web en ${input.monthLabel}: ${subjectParts.join(', ')}`
    : `Tu web en ${input.monthLabel}`;

  // Una métrica a cero los dos meses no aporta nada: fuera.
  const shown = (key: MetricKey) => current[key] > 0 || previous[key] > 0;
  const rows = WEB_RESULT_ROWS.filter((r) => r.key !== 'visitasIa' && shown(r.key)).map((r) => {
    const extra =
      r.key === 'formularios' && current.reservas > 0
        ? ` (${n(current.reservas)} ${current.reservas === 1 ? 'reserva' : 'reservas'})`
        : '';
    return { label: r.label, value: `${n(current[r.key])}${extra}`, change: formatChange(current[r.key], previous[r.key]) };
  });

  const contactos = contactosDe(current);
  const contactosAntes = contactosDe(previous);
  const showContactos = contactos > 0 || contactosAntes > 0;
  const showIa = shown('visitasIa');
  const iaHint = WEB_RESULT_ROWS.find((r) => r.key === 'visitasIa')!.hint;

  const text = [
    'Hola:',
    '',
    `Este es el resumen de ${input.siteName} en ${input.monthLabel}, comparado ${comparedWith}.`,
    '',
    ...(showContactos
      ? [
          `Contactos desde la web: ${n(contactos)} ${formatChange(contactos, contactosAntes)}`,
          'Llamadas, WhatsApp, emails y formularios que empezaron en tu web.',
          '',
        ]
      : []),
    ...rows.map((r) => `· ${r.label}: ${r.value} ${r.change}`),
    ...(showIa
      ? [
          '',
          `Visitas desde buscadores con IA: ${n(current.visitasIa)} ${formatChange(current.visitasIa, previous.visitasIa)}`,
          iaHint,
        ]
      : []),
    '',
    'Las cifras cuentan toques y envíos en tu web. Cuántos acabaron en cita lo sabes tú mejor que nadie.',
    '',
    `Ver el detalle en tu panel: ${input.panelUrl}`,
    '',
    'Recibes este informe una vez al mes porque tu web tiene el Cuidado Premium de Kairikos.',
    '',
    '— Kairikos',
  ].join('\n');

  const cell = 'padding:6px 12px 6px 0;border-bottom:1px solid #e5e7eb;';
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:560px">',
    '<p>Hola:</p>',
    `<p>Este es el resumen de <strong>${escapeHtml(input.siteName)}</strong> en ${escapeHtml(input.monthLabel)}, comparado ${escapeHtml(comparedWith)}.</p>`,
    showContactos
      ? `<p style="font-size:18px;margin:16px 0 4px"><strong>Contactos desde la web: ${escapeHtml(n(contactos))}</strong> <span style="color:#4b5563">${escapeHtml(formatChange(contactos, contactosAntes))}</span></p>` +
        '<p style="margin:0 0 16px;color:#4b5563;font-size:14px">Llamadas, WhatsApp, emails y formularios que empezaron en tu web.</p>'
      : '',
    rows.length > 0
      ? `<table style="border-collapse:collapse;font-size:14px">${rows
          .map(
            (r) =>
              `<tr><td style="${cell}">${escapeHtml(r.label)}</td><td style="${cell}text-align:right"><strong>${escapeHtml(r.value)}</strong></td><td style="${cell}color:#4b5563">${escapeHtml(r.change)}</td></tr>`,
          )
          .join('')}</table>`
      : '',
    showIa
      ? `<p style="margin:16px 0 4px"><strong>Visitas desde buscadores con IA: ${escapeHtml(n(current.visitasIa))}</strong> <span style="color:#4b5563">${escapeHtml(formatChange(current.visitasIa, previous.visitasIa))}</span></p>` +
        `<p style="margin:0;color:#4b5563;font-size:14px">${escapeHtml(iaHint)}</p>`
      : '',
    '<p style="color:#4b5563;font-size:14px">Las cifras cuentan toques y envíos en tu web. Cuántos acabaron en cita lo sabes tú mejor que nadie.</p>',
    `<p><a href="${escapeHtml(input.panelUrl)}">Ver el detalle en tu panel</a></p>`,
    '<p style="color:#6b7280;font-size:12px">Recibes este informe una vez al mes porque tu web tiene el Cuidado Premium de Kairikos.</p>',
    '<p>— Kairikos</p>',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// El barrido
// ---------------------------------------------------------------------------

export interface WebResultsSweepResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Manda el informe del mes pasado a cada sitio que toca. Nunca lanza.
 *
 * Elegible: sitio con token de eventos, sin archivar y con un Cuidado
 * ('web_care') activo para ESE sitio. Cualquier nivel de Cuidado, de
 * momento: el nivel Premium solo se deduce de customPriceCents (12900/17900,
 * CARE_TIERS) y no es una columna. Si hace falta limitarlo a Premium, el
 * filtro va aquí. Sin token no hay nada que contar, así que en la práctica
 * solo lo reciben las webs Premium a las que el operador activó la medición.
 * El Cuidado siempre lleva clientSiteId desde el pago (web-care.ts), por eso
 * no se mira el caso de una contratación sin sitio.
 *
 * El cursor avanza tras CADA intento, salga o no el correo, como
 * client-value-report: con una dirección rota, reintentar en cada tick
 * durante tres días serían cientos de envíos fallidos. Un mes sin ninguna
 * actividad no manda nada (un correo de ceros parece una factura sin
 * servicio) pero también avanza el cursor.
 */
export async function sendWebResultsReports(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<WebResultsSweepResult> {
  const result: WebResultsSweepResult = { considered: 0, sent: 0, skipped: 0, failed: 0 };

  let sites;
  try {
    // El filtro de «¿toca?» va en TypeScript (isResultsReportDue), pero los
    // días 4 a 31 ni se consulta: no puede tocar a nadie.
    if (!isResultsReportDue(now, null)) return result;
    sites = await db.clientSite.findMany({
      where: {
        eventsToken: { not: null },
        archivedAt: null,
        products: { some: { status: 'active', product: { code: WEB_CARE_PRODUCT_CODE } } },
      },
      select: {
        id: true,
        name: true,
        lastResultsReportAt: true,
        client: { select: { email: true } },
        products: {
          where: { status: { in: WEB_ACCESSIBLE_STATUSES }, product: { code: 'web' } },
          orderBy: { subscribedAt: 'asc' },
          take: 1,
          select: { id: true },
        },
      },
    });
  } catch (err) {
    logError('web_results_report.query_failed', err, {}, 'warn');
    return result;
  }

  const month = previousLocalMonth(now, WEB_RESULTS_TIMEZONE);
  const before = shiftLocalMonth(month, -1);
  const currentRange = monthRange(month);
  const previousRange = monthRange(before);

  for (const site of sites) {
    if (!isResultsReportDue(now, site.lastResultsReportAt)) continue;
    result.considered += 1;
    try {
      const [current, previous] = await Promise.all([
        computeWebResults(db, site.id, currentRange.since, currentRange.until),
        computeWebResults(db, site.id, previousRange.since, previousRange.until),
      ]);

      if (!hasAnyActivity(current)) {
        result.skipped += 1;
      } else {
        const webProductId = site.products[0]?.id;
        const panelUrl = `${portalBaseUrl()}/portal/web${webProductId ? `/${webProductId}` : ''}`;
        const rendered = buildWebResultsEmail({
          siteName: site.name,
          monthLabel: monthLabel(month),
          previousMonthLabel: monthLabel(before),
          current,
          previous,
          panelUrl,
        });
        const ok = await sendWebResultsEmail(site.client.email, rendered, site.id);
        if (ok) result.sent += 1;
        else result.failed += 1;
      }

      await db.clientSite.update({ where: { id: site.id }, data: { lastResultsReportAt: now } });
    } catch (err) {
      result.failed += 1;
      logError('web_results_report.site_failed', err, { clientSiteId: site.id }, 'warn');
    }
  }

  return result;
}

async function sendWebResultsEmail(
  to: string,
  rendered: { subject: string; text: string; html: string },
  clientSiteId: string,
): Promise<boolean> {
  if (!to || !to.includes('@')) return false;
  // || y no ??: una variable declarada y vacía cuenta como ausente (trampa 4).
  const apiKey = process.env.RESEND_API_KEY?.trim() || '';
  if (!apiKey) return false;

  try {
    // await import y no require: el require de la trampa 4 de CLAUDE.md no
    // existe en el bundle de producción.
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const sent = await resend.emails.send({ from: notifyFromAddress(), to: [to], ...rendered });
    if (sent.error) {
      logError('web_results_report.send_failed', new Error(sent.error.message), { clientSiteId }, 'warn');
      return false;
    }
    return true;
  } catch (err) {
    logError('web_results_report.send_failed', err, { clientSiteId }, 'warn');
    return false;
  }
}
