import { z } from 'zod';

// =============================================================================
// Cartera — los contactos de la web (PR 5): qué manda cada formulario, cómo se
// enseña en español y los correos. Puro: sin base de datos ni red.
//
// El contrato es docs/contactos.md de la plantilla web, y su
// src/scripts/lead.ts ya lo cumple en producción. Lo que la web manda de más
// se ignora (Zod quita las claves desconocidas): la web puede añadir un campo
// antes que el portal. Lo que falta o no tiene forma, 400.
//
// Algunos campos llegan vacíos o nulos aunque el contrato liste valores: un
// <select> con la opción «Todavía no lo sé» manda "", un parámetro de la URL
// que no está manda null. Se aceptan y se guardan como null: rechazarlos
// perdería un contacto real por un campo opcional.
// =============================================================================

export const ENQUIRY_KINDS = ['visit', 'valuation', 'landlord', 'offmarket', 'report', 'saved_email', 'saved_agency'] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];
export type Lang = 'es' | 'en' | 'de';

/** El tipo, como lo enseña el panel. En la base de datos va el de la web tal cual. */
export const KIND_LABELS: Record<EnquiryKind, string> = {
  visit: 'Visita',
  valuation: 'Valoración',
  landlord: 'Propietario de alquiler',
  offmarket: 'Fuera de mercado',
  report: 'Informe de mercado',
  saved_email: 'Guardadas, por email',
  saved_agency: 'Guardadas, a la agencia',
};

export const ENQUIRY_STATUSES = ['nuevo', 'atendido'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** 20 envíos por hora y token (en memoria, como villas). */
export const ENQUIRIES_PER_HOUR = 20;
/** «Mándamela por email»: como mucho 3 al día al mismo destino. */
export const SAVED_EMAILS_PER_DAY = 3;
/** Se guardan 24 meses desde que llegan (fase1-cartera.md, «Seguridad y datos»). */
export const RETENTION_MONTHS = 24;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;

// --- Validación --------------------------------------------------------------

const REF = /^[A-Z]-\d{2,4}$/;
const ZONE = /^[a-z0-9-]{1,40}$/;

const zone = z.string().regex(ZONE);
/** Zona opcional: "" («Cualquiera») o ausente cuentan como sin zona. */
const optionalZone = z
  .union([z.literal(''), zone])
  .nullable()
  .optional()
  .transform((v) => v || null);
/** Un valor de una lista cerrada que puede llegar como "" o null: sin elegir. */
const optionalChoice = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.literal(''), z.enum(values)])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const refs = z
  .array(z.string().regex(REF))
  .min(1)
  .max(30)
  .transform((list) => [...new Set(list)]);

/** El idioma de la página (`document.documentElement.lang`): «es», «en» o «de». */
const lang = z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 2) : v), z.enum(['es', 'en', 'de']));

const common = {
  name: z.string().trim().min(1).max(100),
  contact: z.string().trim().min(5).max(200),
  consent: z.literal(true),
  lang,
  website: z.string().max(500).optional(),
};

const email = z.string().trim().toLowerCase().email().max(200);

export const enquirySchema = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('visit'),
    ref: z
      .union([z.literal(''), z.string().regex(REF)])
      .nullable()
      .optional()
      .transform((v) => v || null),
    slots: z
      .array(z.string().regex(/^(lun|mar|mie|jue|vie|sab)-(m|t)$/))
      .max(3)
      .default([])
      .transform((list) => [...new Set(list)]),
    mode: optionalChoice(['presencial', 'video'] as const),
    situation: optionalChoice(['contado', 'aprobada', 'vendo', 'alquilo', 'mirando'] as const),
    // Sale de un parámetro de la URL (?origen=chat): lo que no sea «chat» no se guarda.
    origin: z
      .string()
      .max(40)
      .nullable()
      .optional()
      .transform((v) => (v === 'chat' ? 'chat' : null)),
  }),
  z.object({
    ...common,
    kind: z.literal('valuation'),
    zone,
    type: z.enum(['piso', 'atico', 'adosado', 'villa', 'rural']),
    usable: z.number().int().min(30).max(1500),
    state: z.enum(['reformada', 'buena', 'reformar']),
    extras: z
      .array(z.enum(['vistas', 'piscina', 'garaje']))
      .max(3)
      .default([])
      .transform((list) => [...new Set(list)]),
    // `Number('')` es 0 y `Number('x')` es NaN, que JSON manda como null.
    beds: z
      .number()
      .int()
      .min(0)
      .max(50)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    marketing: z.boolean().default(false),
  }),
  z.object({ ...common, kind: z.literal('landlord'), zone: optionalZone, service: optionalChoice(['buscar', 'gestion'] as const) }),
  z.object({ ...common, kind: z.literal('offmarket'), zone: optionalZone, budget: optionalChoice(['<1.5M', '1.5M-3M', '3M-6M', '>6M'] as const) }),
  z.object({ ...common, kind: z.literal('report') }),
  // Sin nombre: solo el email al que se manda la lista.
  z.object({ ...common, kind: z.literal('saved_email'), name: z.string().trim().max(100).optional(), contact: email, refs }),
  z.object({ ...common, kind: z.literal('saved_agency'), refs }),
]);

export type EnquiryInput = z.infer<typeof enquirySchema>;

/** Lo propio de cada tipo, que va a `payload`. Ni los comunes ni la trampa. */
export function enquiryPayload(input: EnquiryInput): Record<string, unknown> {
  const { kind: _k, name: _n, contact: _c, consent: _co, lang: _l, website: _w, ...rest } = input;
  if ('refs' in rest) {
    const { refs: _r, ...others } = rest;
    return others;
  }
  if ('ref' in rest) {
    const { ref: _r, ...others } = rest;
    return others;
  }
  return rest;
}

/** Las referencias que van a `CarteraEnquiry.refs`. */
export function enquiryRefs(input: EnquiryInput): string[] {
  if (input.kind === 'visit') return input.ref ? [input.ref] : [];
  if (input.kind === 'saved_email' || input.kind === 'saved_agency') return input.refs;
  return [];
}

/** El cuerpo trae la trampa llena: es un bot. Se mira antes de validar nada. */
export function isHoneypot(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const w = (body as Record<string, unknown>).website;
  return typeof w === 'string' ? w.trim().length > 0 : w !== undefined && w !== null && w !== false;
}

/** Hace 24 meses, en meses de calendario. */
export function retentionCutoff(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS);
  return d;
}

export function isPurgeDue(lastRun: Date | null, now: Date): boolean {
  return !lastRun || now.getTime() - lastRun.getTime() >= PURGE_EVERY_MS;
}

// --- En español, para el panel, el correo a la agencia y el Lead ----------------

const SLOT_DAYS: Record<string, string> = { lun: 'lunes', mar: 'martes', mie: 'miércoles', jue: 'jueves', vie: 'viernes', sab: 'sábado' };
const SITUATIONS: Record<string, string> = {
  contado: 'compra sin hipoteca',
  aprobada: 'financiación aprobada',
  vendo: 'vende otra casa para comprar',
  alquilo: 'está de alquiler',
  mirando: 'está mirando',
};
const BUDGETS: Record<string, string> = { '<1.5M': 'hasta 1,5 M€', '1.5M-3M': 'de 1,5 a 3 M€', '3M-6M': 'de 3 a 6 M€', '>6M': 'más de 6 M€' };
const VALUATION_TYPES: Record<string, string> = { piso: 'piso', atico: 'ático', adosado: 'adosado', villa: 'villa', rural: 'casa rural' };
const VALUATION_STATES: Record<string, string> = { reformada: 'reformada', buena: 'en buen estado', reformar: 'para reformar' };
const SERVICES: Record<string, string> = { buscar: 'buscar inquilino', gestion: 'gestión del alquiler' };

/** Una línea con lo que pidió, sin datos personales (no lleva nombre ni contacto). */
export function describeEnquiry(kind: string, payload: Record<string, unknown>, refs: readonly string[]): string {
  const p = payload;
  const parts: string[] = [];
  switch (kind) {
    case 'visit': {
      const slots = Array.isArray(p.slots) ? (p.slots as string[]) : [];
      if (slots.length) parts.push(`franjas: ${slots.map((s) => `${SLOT_DAYS[s.slice(0, 3)] ?? s} ${s.endsWith('-m') ? 'por la mañana' : 'por la tarde'}`).join(', ')}`);
      if (p.mode) parts.push(p.mode === 'video' ? 'por videollamada' : 'en persona');
      if (typeof p.situation === 'string' && SITUATIONS[p.situation]) parts.push(SITUATIONS[p.situation]);
      if (p.origin === 'chat') parts.push('llega desde el chat');
      if (!refs.length) parts.push('sin casa elegida');
      break;
    }
    case 'valuation': {
      parts.push(`zona ${String(p.zone)}`, VALUATION_TYPES[String(p.type)] ?? String(p.type), `${String(p.usable)} m² útiles`, VALUATION_STATES[String(p.state)] ?? String(p.state));
      if (typeof p.beds === 'number') parts.push(`${p.beds} dormitorios`);
      const extras = Array.isArray(p.extras) ? (p.extras as string[]) : [];
      if (extras.length) parts.push(`con ${extras.join(', ')}`);
      if (p.marketing) parts.push('quiere el informe trimestral');
      break;
    }
    case 'landlord':
      parts.push(p.zone ? `zona ${String(p.zone)}` : 'sin zona');
      parts.push(typeof p.service === 'string' && SERVICES[p.service] ? SERVICES[p.service] : 'servicio sin decidir');
      break;
    case 'offmarket':
      parts.push(p.zone ? `zona ${String(p.zone)}` : 'cualquier zona');
      if (typeof p.budget === 'string' && BUDGETS[p.budget]) parts.push(`presupuesto ${BUDGETS[p.budget]}`);
      break;
    case 'report':
      parts.push('pide el informe de mercado trimestral');
      break;
    case 'saved_email':
      parts.push(`se le ha mandado la lista de ${refs.length} ${refs.length === 1 ? 'casa' : 'casas'} por email`);
      break;
    case 'saved_agency':
      parts.push(`${refs.length} ${refs.length === 1 ? 'casa guardada' : 'casas guardadas'}`);
      break;
  }
  const text = parts.join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

// --- Las casas que nombra un contacto --------------------------------------------

/** Lo que hace falta de cada casa publicada para nombrarla y enlazarla. */
export interface EnquiryHome {
  ref: string;
  operation: 'venta' | 'alquiler';
  title: Record<Lang, string>;
  slugs: Record<Lang, string>;
  /** Precio de venta o renta mensual. */
  amount: number;
}

// Las rutas de la web (src/i18n/index.ts, `routes.buy`, `routes.rent`, `routes.saved`).
const BUY: Record<Lang, string> = { es: '/comprar/', en: '/en/buy/', de: '/de/kaufen/' };
const RENT: Record<Lang, string> = { es: '/alquiler/', en: '/en/rent/', de: '/de/mieten/' };
const SAVED: Record<Lang, string> = { es: '/guardadas/', en: '/en/saved/', de: '/de/gemerkt/' };

const origin = (siteUrl: string) => siteUrl.replace(/\/+$/, '');

/** La ficha en la web, como `propertyHref` / `rentalHref` de la plantilla. */
export function homeUrl(siteUrl: string, home: EnquiryHome, lang: Lang): string {
  return `${origin(siteUrl)}${(home.operation === 'venta' ? BUY : RENT)[lang]}${home.slugs[lang]}/`;
}

/** La lista compartida, como el botón «Compartir» de /guardadas: `?refs=C-101,A-201`. */
export function savedListUrl(siteUrl: string, refs: readonly string[], lang: Lang): string {
  return `${origin(siteUrl)}${SAVED[lang]}?refs=${refs.join(',')}`;
}

/** «2.950.000 €» (es, de) o «€2,950,000» (en), como `eur` de la web; la renta, al mes. */
export function priceText(home: EnquiryHome, lang: Lang): string {
  const n = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : lang === 'de' ? 'de-DE' : 'es-ES', {
    maximumFractionDigits: 0,
    useGrouping: 'always' as unknown as boolean,
  }).format(home.amount);
  const money = lang === 'en' ? `€${n}` : `${n} €`;
  if (home.operation === 'venta') return money;
  return `${money}${{ es: '/mes', en: '/month', de: '/Monat' }[lang]}`;
}

// --- Correos -----------------------------------------------------------------------

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Una línea de cabecera segura: sin saltos de línea ni caracteres de control. */
export function headerSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\u0000-\u001f\u007f<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const SAVED_TEXT: Record<Lang, { subject: (agency: string) => string; intro: (agency: string) => string; list: string; footer: (agency: string) => string }> = {
  es: {
    subject: (a) => `Tus casas guardadas en ${a}`,
    intro: (a) => `Estas son las casas que guardaste en la web de ${a}:`,
    list: 'Ver la lista en la web',
    footer: (a) => `Alguien pidió esta lista desde la web de ${a}; si no fuiste tú, ignora este correo.`,
  },
  en: {
    subject: (a) => `Your saved homes at ${a}`,
    intro: (a) => `These are the homes you saved on the ${a} website:`,
    list: 'See the list on the website',
    footer: (a) => `Someone asked for this list on the ${a} website; if it was not you, please ignore this email.`,
  },
  de: {
    subject: (a) => `Ihre gemerkten Immobilien bei ${a}`,
    intro: (a) => `Diese Immobilien haben Sie auf der Website von ${a} gemerkt:`,
    list: 'Die Liste auf der Website ansehen',
    footer: (a) => `Jemand hat diese Liste auf der Website von ${a} angefordert; falls Sie das nicht waren, ignorieren Sie diese E-Mail bitte.`,
  },
};

/**
 * El correo al comprador de «Mándamela por email». Texto fijo: título, precio y
 * enlace de cada casa, y el enlace de la lista. No lleva nada que escriba el
 * comprador, así que no sirve para mandarle a un tercero un mensaje propio.
 */
export function renderSavedListEmail(input: { agencyName: string; siteUrl: string; lang: Lang; homes: readonly EnquiryHome[] }): RenderedEmail {
  const t = SAVED_TEXT[input.lang];
  const agency = headerSafe(input.agencyName);
  const items = input.homes.map((h) => ({ title: h.title[input.lang] || h.title.es, price: priceText(h, input.lang), url: homeUrl(input.siteUrl, h, input.lang) }));
  const list = savedListUrl(
    input.siteUrl,
    input.homes.map((h) => h.ref),
    input.lang,
  );
  const text = [t.intro(agency), '', ...items.flatMap((i) => [`${i.title} — ${i.price}`, i.url, '']), `${t.list}: ${list}`, '', '—', t.footer(agency)].join('\n');
  const html = [
    `<p>${escapeHtml(t.intro(agency))}</p>`,
    '<ul>',
    ...items.map((i) => `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.title)}</a> — ${escapeHtml(i.price)}</li>`),
    '</ul>',
    `<p><a href="${escapeHtml(list)}">${escapeHtml(t.list)}</a></p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(t.footer(agency))}</p>`,
  ].join('\n');
  return { subject: t.subject(agency), text, html };
}

const LANG_NAMES: Record<string, string> = { es: 'español', en: 'inglés', de: 'alemán' };

/** El aviso a la agencia: un contacto nuevo, con sus casas enlazadas. */
export function renderAgencyEnquiryEmail(input: {
  kind: string;
  name: string | null;
  contact: string;
  lang: string;
  consentAt: Date;
  summary: string;
  refs: readonly string[];
  homes: ReadonlyMap<string, EnquiryHome>;
  siteUrl: string | null;
  panelUrl: string;
}): RenderedEmail {
  const label = KIND_LABELS[input.kind as EnquiryKind] ?? input.kind;
  // En el HTML solo se enlazan las URL que monta el portal (la ficha y el panel),
  // nunca algo que haya escrito el comprador: el formulario es público y no debe
  // poder meter enlaces pulsables en el correo de la agencia. Hasta el 20/11/2026
  // iban todas como texto y algunos clientes de correo no las enlazaban.
  const links = new Map<string, string>();
  const homeLines = input.refs.map((ref) => {
    const h = input.homes.get(ref);
    if (!h) return `${ref} (ya no está publicada)`;
    if (!input.siteUrl) return `${ref} · ${h.title.es}`;
    const url = homeUrl(input.siteUrl, h, 'es');
    const line = `${ref} · ${h.title.es} — ${url}`;
    links.set(line, url);
    return line;
  });
  const panelLine = `Todos tus contactos: ${input.panelUrl}`;
  links.set(panelLine, input.panelUrl);
  const lines = [
    `Nuevo contacto desde tu web: ${label}.`,
    '',
    input.name ? `Nombre: ${input.name}` : '',
    `Contacto: ${input.contact}`,
    `Idioma: ${LANG_NAMES[input.lang] ?? input.lang}`,
    input.summary ? `Detalle: ${input.summary}` : '',
    ...(homeLines.length ? ['', input.refs.length === 1 ? 'Casa:' : 'Casas:', ...homeLines] : []),
    '',
    `Aceptó la política de privacidad el ${input.consentAt.toISOString().slice(0, 16).replace('T', ' ')} (UTC).`,
    panelLine,
  ].filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
  const html = lines
    .map((l) => {
      if (!l) return '';
      const url = links.get(l);
      if (!url) return `<p>${escapeHtml(l)}</p>`;
      return `<p>${escapeHtml(l.slice(0, l.length - url.length))}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
    })
    .join('\n');
  const who = input.name ? ` de ${headerSafe(input.name)}` : '';
  const refsText = input.refs.length ? ` (${input.refs.slice(0, 3).join(', ')}${input.refs.length > 3 ? '…' : ''})` : '';
  return { subject: `${label}${who}${refsText}`, text: lines.join('\n'), html };
}

/** El resumen del Lead: el tipo, lo pedido y las casas por su nombre. */
export function leadSummary(kind: string, summary: string, refs: readonly string[], homes: ReadonlyMap<string, EnquiryHome>): string {
  const label = KIND_LABELS[kind as EnquiryKind] ?? kind;
  const named = refs.map((r) => (homes.get(r) ? `${r} (${homes.get(r)!.title.es})` : r));
  return [`Web inmobiliaria · ${label}.`, summary ? `${summary}.` : '', named.length ? `${named.length === 1 ? 'Casa' : 'Casas'}: ${named.join(', ')}.` : ''].filter(Boolean).join(' ').slice(0, 2000);
}
