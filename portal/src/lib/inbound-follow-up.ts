import 'server-only';
import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { notifyFromAddress } from './email-sender';
import { portalBaseUrl } from './portal-base-url';
import { supportWhatsappUrl } from './portal-data';
import { RECALL_ON_SALE } from './daily-call-list';
import { localMinutesFor } from './recall-digest';
import { logError } from './observability';

// =============================================================================
// 25/10/2026 — seguimiento por correo a los contactos que llegan solos.
//
// Las dos herramientas públicas de kairikos.com que recogen un contacto —el
// borrador de web (/web) y la calculadora de llamadas (/llamadas)— guardaban
// la fila y como mucho la enseñaban en el correo de las 8:30. Nadie le
// escribía a quien la había pedido: ni siquiera para mandarle su resultado.
// Hasta hoy NO salía ningún correo al pedir el borrador ni al usar la
// calculadora (comprobado en sus dos rutas), así que el día 0 no duplica nada.
//
// Qué recibe, solo si marcó la casilla de comunicaciones comerciales y dejó un
// EMAIL (un teléfono queda fuera: escribir por WhatsApp pide plantillas
// aprobadas por Meta y el alta como Tech Provider, que no tenemos):
//   - día 0: lo que pidió — el enlace a su borrador, o su cálculo con sus
//     propios números—, y cómo seguir. Desde el 30/10/2026 el del borrador lo
//     manda la entrega (public-draft-delivery.ts) a todos los que dejaron
//     correo, y la secuencia de un borrador cuenta desde que se envió.
//   - día 3: un empujón corto con la llamada de 20 minutos y el WhatsApp.
//   - día 7: el último, y lo dice.
//
// Se corta si se da de baja (en cualquiera de las dos tablas: la baja es de
// una persona, no de una fila), si ya es cliente (hay cuenta con ese email) o
// si el operador ya habló con él (contactedAt): a partir de ahí la relación es
// una conversación, no una secuencia.
//
// Los contactos del chatbot NO entran, a propósito: su texto de consentimiento
// dice «solo para responder a tu consulta».
//
// Art. 21 LSSI: cada correo dice quién escribe y por qué, y lleva un enlace de
// baja de un clic que funciona (/api/public/baja/<testigo>), además de la
// cabecera List-Unsubscribe de un clic (RFC 8058) que piden Gmail y Yahoo.
//
// Idempotencia: cada toque es una fila de InboundFollowUpEmail con clave única
// (source, sourceId, step), reservada ANTES de mandar. Dos barridos a la vez
// chocan en la clave y solo uno manda. LIMITACIÓN ACEPTADA: si el proceso
// muere entre reservar y mandar, ese toque queda «sending» y no se reintenta;
// es preferible perder un correo a mandar dos.
// =============================================================================

export type FollowUpSource = 'web_draft' | 'calculator';
export type FollowUpStepKey = 'dia_0' | 'dia_3' | 'dia_7';

export interface FollowUpStep {
  key: FollowUpStepKey;
  afterDays: number;
}

export const FOLLOW_UP_STEPS: readonly FollowUpStep[] = Object.freeze([
  { key: 'dia_0', afterDays: 0 },
  { key: 'dia_3', afterDays: 3 },
  { key: 'dia_7', afterDays: 7 },
]);

/** Pasado este plazo, lo que quede de la secuencia se sella sin mandar. Es lo
 *  que impide que, el día que se despliega esto (o tras un parón del
 *  scheduler), alguien que pidió su borrador hace un mes reciba de golpe un
 *  «aquí tienes tu borrador». */
export const FOLLOW_UP_MAX_AGE_DAYS = 10;

/** Nunca dos correos en menos de esto, aunque el barrido vaya con retraso. */
export const FOLLOW_UP_MIN_GAP_MS = 2 * 24 * 60 * 60 * 1000;

/** Hora local de quien recibe: los clientes son de Canarias. El día 0 sale a
 *  cualquier hora porque es la respuesta a algo que acaba de pedir; los otros
 *  dos son comerciales y esperan a una hora razonable. */
const FOLLOW_UP_TIMEZONE = 'Atlantic/Canary';
const SEND_FROM_MINUTES = 9 * 60;
const SEND_UNTIL_MINUTES = 20 * 60;

/** Tope por barrido: el scheduler pasa cada 5 minutos. */
const MAX_SENDS_PER_SWEEP = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
export const KAIRIKOS_CONTACT_EMAIL = 'contacto@kairikos.com';

// --- Puras -------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;

/** El email normalizado si el contacto es un email; null si es un teléfono u
 *  otra cosa. */
export function emailFromContact(contact: string): string | null {
  const value = contact.trim().toLowerCase();
  return EMAIL_RE.test(value) ? value : null;
}

export function withinSendingHours(now: Date): boolean {
  const minutes = localMinutesFor(now, FOLLOW_UP_TIMEZONE);
  return minutes >= SEND_FROM_MINUTES && minutes < SEND_UNTIL_MINUTES;
}

export interface FollowUpDecision {
  /** El paso que toca mandar ahora, o null. */
  send: FollowUpStepKey | null;
  /** Pasos que ya no se van a mandar y hay que sellar como «skipped». */
  skip: FollowUpStepKey[];
}

/**
 * Qué toca con un contacto. Pura para poder probar los bordes —recién llegado,
 * barrido parado tres días, secuencia caducada, fuera de hora— sin base de
 * datos.
 *
 * Si el barrido se retrasa y vencen dos pasos a la vez, se manda solo el más
 * reciente y el anterior se sella: dos correos seguidos delatan que algo se
 * paró, y el más reciente es el que tiene sentido ese día.
 */
export function nextFollowUpStep(
  input: { createdAt: Date; done: ReadonlySet<string>; lastSentAt: Date | null },
  now: Date,
): FollowUpDecision {
  const pending = FOLLOW_UP_STEPS.filter((s) => !input.done.has(s.key));
  if (pending.length === 0) return { send: null, skip: [] };

  const ageDays = (now.getTime() - input.createdAt.getTime()) / DAY_MS;
  if (ageDays > FOLLOW_UP_MAX_AGE_DAYS) {
    return { send: null, skip: pending.map((s) => s.key) };
  }

  const due = pending.filter((s) => ageDays >= s.afterDays);
  if (due.length === 0) return { send: null, skip: [] };

  const latest = due[due.length - 1];
  const skip = due.slice(0, -1).map((s) => s.key);

  if (input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < FOLLOW_UP_MIN_GAP_MS) {
    return { send: null, skip };
  }
  if (latest.key !== 'dia_0' && !withinSendingHours(now)) {
    return { send: null, skip };
  }
  return { send: latest.key, skip };
}

export type FollowUpStopReason = 'unsubscribed' | 'is_client' | 'contacted';

/** Por qué no se le escribe más, o null si se le puede escribir. */
export function followUpStopReason(input: {
  unsubscribed: boolean;
  isClient: boolean;
  contacted: boolean;
}): FollowUpStopReason | null {
  if (input.unsubscribed) return 'unsubscribed';
  if (input.isClient) return 'is_client';
  if (input.contacted) return 'contacted';
  return null;
}

export type FollowUpContact =
  | { kind: 'web_draft'; businessName: string; city: string; draftUrl: string }
  | {
      kind: 'calculator';
      businessName: string | null;
      missedCallsPerWeek: number;
      averageJobValueCents: number;
      annualLossCents: number;
    };

export interface FollowUpLinks {
  unsubscribeUrl: string;
  /** La página de contacto de kairikos.com: el enlace de la demo vive ahí, en
   *  un solo sitio (Ajustes → Generales de WordPress), y no se copia aquí. */
  contactUrl: string;
  whatsappUrl: string;
  /** Precio de la web desde el catálogo; null si no se pudo leer (entonces el
   *  correo no da cifra, en vez de inventarla). */
  webPriceCents: number | null;
  /** Llamadas a la venta (RECALL_ON_SALE). Mientras no, se ofrece apuntarse. */
  recallOnSale: boolean;
  recallUrl: string;
}

const EUR = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

export function euros(cents: number): string {
  return `${EUR.format(Math.round(cents / 100))} €`;
}

export function followUpFooter(links: Pick<FollowUpLinks, 'unsubscribeUrl'>): string[] {
  return [
    '',
    '—',
    'Orlando Perdomo · Kairikos (kairikos.com)',
    `Te escribimos porque en kairikos.com marcaste que querías recibir ideas para tu negocio. Puedes responder a este correo o escribir a ${KAIRIKOS_CONTACT_EMAIL}. Cómo tratamos tus datos: https://kairikos.com/privacidad/`,
    `Darte de baja (un clic, no te volvemos a escribir): ${links.unsubscribeUrl}`,
  ];
}

/** Puro: el correo de cada paso. Todos juntos para poder leer de una vez lo
 *  que recibe una persona en una semana. Solo cifras que dio ella o que salen
 *  del catálogo; precio final, nunca «sin IVA». */
export function buildFollowUpEmail(
  step: FollowUpStepKey,
  contact: FollowUpContact,
  links: FollowUpLinks,
): { subject: string; text: string } {
  const lines: string[] = [];
  let subject: string;

  if (contact.kind === 'web_draft') {
    const negocio = contact.businessName;
    const precio =
      links.webPriceCents !== null
        ? `Si te gusta, la dejamos publicada con tu dominio por ${euros(links.webPriceCents)}, pago único, con dominio y alojamiento del primer año incluidos. Es el precio final: no se le suma ningún impuesto.`
        : 'Si te gusta, la dejamos publicada con tu dominio, con dominio y alojamiento del primer año incluidos.';

    if (step === 'dia_0') {
      subject = `Tu borrador de web: ${negocio}`;
      lines.push(
        'Hola,',
        '',
        `Aquí tienes el borrador de la web de ${negocio} que pediste en kairikos.com:`,
        contact.draftUrl,
        '',
        'Está hecho con los datos públicos de tu ficha de Google. Lo que no te encaje se cambia: textos, fotos, servicios.',
        '',
        precio,
        '',
        `¿Lo vemos juntos 20 minutos? Reserva aquí: ${links.contactUrl}`,
        `O escríbenos por WhatsApp: ${links.whatsappUrl}`,
      );
    } else if (step === 'dia_3') {
      subject = `¿Le echaste un vistazo a la web de ${negocio}?`;
      lines.push(
        'Hola,',
        '',
        `Te escribo por el borrador de la web de ${negocio}. Sigue aquí:`,
        contact.draftUrl,
        '',
        'Si hay algo que cambiarías, respóndeme con una línea y te digo cómo quedaría. Y si prefieres hablarlo, son 20 minutos:',
        links.contactUrl,
      );
    } else {
      subject = `Último correo sobre la web de ${negocio}`;
      lines.push(
        'Hola,',
        '',
        'Este es el último correo que te mando sobre esto: no quiero llenarte la bandeja.',
        '',
        `El borrador de ${negocio} sigue en ${contact.draftUrl}. Si algún día te encaja, respóndeme a este correo y lo retomamos donde lo dejamos.`,
      );
    }
  } else {
    const negocio = contact.businessName?.trim() || 'tu negocio';
    const oferta = links.recallOnSale
      ? `Llamadas recuperadas coge las llamadas que no puedes atender, te pasa el recado por WhatsApp y escribe a quien llamó. Lo tienes en ${links.recallUrl}`
      : 'Estamos lanzando Llamadas recuperadas: coge las llamadas que no puedes atender, te pasa el recado por WhatsApp y escribe a quien llamó. Estamos eligiendo los primeros negocios con los que ponerlo en marcha; si te interesa, responde a este correo y te apuntamos.';

    if (step === 'dia_0') {
      subject = 'Tu cálculo de llamadas perdidas';
      lines.push(
        'Hola,',
        '',
        `Este es el cálculo que hiciste en kairikos.com para ${negocio}:`,
        `- Llamadas que no coges a la semana: ${contact.missedCallsPerWeek}`,
        `- Encargo medio: ${euros(contact.averageJobValueCents)}`,
        `- Lo que se queda sin contestar al año: unos ${euros(contact.annualLossCents)}`,
        '',
        'Son tus números con los supuestos de la calculadora: una estimación, no una medición.',
        '',
        oferta,
        '',
        `Si prefieres hablarlo, son 20 minutos: ${links.contactUrl}`,
        `O por WhatsApp: ${links.whatsappUrl}`,
      );
    } else if (step === 'dia_3') {
      subject = 'Las llamadas que no coges';
      lines.push(
        'Hola,',
        '',
        `Hace unos días calculaste que a ${negocio} se le quedan sin contestar unos ${euros(contact.annualLossCents)} al año en llamadas.`,
        '',
        'Si quieres, te enseño en 20 minutos cómo funcionaría con tu teléfono, con tu caso y sin compromiso:',
        links.contactUrl,
      );
    } else {
      subject = 'Último correo sobre tus llamadas perdidas';
      lines.push(
        'Hola,',
        '',
        'Este es el último correo que te mando sobre esto: no quiero llenarte la bandeja.',
        '',
        'Si algún día quieres que lo veamos, respóndeme a este correo y lo retomamos.',
      );
    }
  }

  lines.push(...followUpFooter(links));
  return { subject, text: lines.join('\n') };
}

// --- Baja --------------------------------------------------------------------

export function newUnsubscribeToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Formato del testigo: lo que genera newUnsubscribeToken. Filtra antes de ir
 *  a la base de datos con cualquier cosa que llegue por la URL. */
export function isPlausibleUnsubscribeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

/**
 * Da de baja a la persona dueña del testigo: todas sus filas, en las dos
 * tablas, con el mismo email. Idempotente: un segundo clic (o el escáner de
 * enlaces de un antivirus) no cambia nada ni da error.
 */
export async function unsubscribeByToken(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<{ ok: boolean }> {
  if (!isPlausibleUnsubscribeToken(token)) return { ok: false };

  const [draft, calc] = await Promise.all([
    prisma.publicDraftRequest.findUnique({ where: { unsubscribeToken: token }, select: { contact: true } }),
    prisma.calculatorLead.findUnique({ where: { unsubscribeToken: token }, select: { contact: true } }),
  ]);
  const contact = draft?.contact ?? calc?.contact;
  if (!contact) return { ok: false };

  const email = emailFromContact(contact);
  const sameContact = email
    ? { contact: { equals: email, mode: 'insensitive' as const } }
    : { unsubscribeToken: token };

  await Promise.all([
    prisma.publicDraftRequest.updateMany({ where: { ...sameContact, unsubscribedAt: null }, data: { unsubscribedAt: now } }),
    prisma.calculatorLead.updateMany({ where: { ...sameContact, unsubscribedAt: null }, data: { unsubscribedAt: now } }),
  ]);
  return { ok: true };
}

// --- Barrido -----------------------------------------------------------------

interface Candidate {
  source: FollowUpSource;
  id: string;
  email: string;
  createdAt: Date;
  unsubscribeToken: string | null;
  contact: FollowUpContact;
}

export interface FollowUpSweepResult {
  candidates: number;
  sent: number;
  failed: number;
  skipped: number;
  stopped: number;
}

export async function sweepInboundFollowUps(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<FollowUpSweepResult> {
  const result: FollowUpSweepResult = { candidates: 0, sent: 0, failed: 0, skipped: 0, stopped: 0 };
  // Sin clave de Resend no se reserva nada: cada toque se marcaría «failed» y
  // se perdería para siempre, cuando lo único que falta es configuración.
  if (!process.env.RESEND_API_KEY?.trim()) return result;
  const since = new Date(now.getTime() - (FOLLOW_UP_MAX_AGE_DAYS + 1) * DAY_MS);
  const base = portalBaseUrl();

  const [drafts, calcs] = await Promise.all([
    // 30/10/2026 — un borrador cuenta desde que se le ENVIÓ, no desde que lo
    // pidió (public-draft-delivery.ts): hasta entonces no tiene nada que ver.
    prisma.publicDraftRequest.findMany({
      where: { marketingConsentAt: { not: null }, sentAt: { gte: since } },
      select: { id: true, token: true, contact: true, businessName: true, city: true, sentAt: true, unsubscribeToken: true },
    }),
    prisma.calculatorLead.findMany({
      where: { marketingConsentAt: { not: null }, createdAt: { gte: since } },
      select: {
        id: true,
        contact: true,
        businessName: true,
        missedCallsPerWeek: true,
        averageJobValueCents: true,
        annualLossCents: true,
        createdAt: true,
        unsubscribeToken: true,
      },
    }),
  ]);

  const candidates: Candidate[] = [];
  for (const d of drafts) {
    const email = emailFromContact(d.contact);
    if (!email || !d.sentAt) continue;
    candidates.push({
      source: 'web_draft',
      id: d.id,
      email,
      createdAt: d.sentAt,
      unsubscribeToken: d.unsubscribeToken,
      contact: { kind: 'web_draft', businessName: d.businessName, city: d.city, draftUrl: `${base}/mi-web/${d.token}` },
    });
  }
  for (const c of calcs) {
    const email = emailFromContact(c.contact);
    if (!email) continue;
    candidates.push({
      source: 'calculator',
      id: c.id,
      email,
      createdAt: c.createdAt,
      unsubscribeToken: c.unsubscribeToken,
      contact: {
        kind: 'calculator',
        businessName: c.businessName,
        missedCallsPerWeek: c.missedCallsPerWeek,
        averageJobValueCents: c.averageJobValueCents,
        annualLossCents: c.annualLossCents,
      },
    });
  }
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const emails = [...new Set(candidates.map((c) => c.email))];
  const byEmail = emails.map((e) => ({ contact: { equals: e, mode: 'insensitive' as const } }));

  // Las paradas miran TODAS las filas de esa persona, no solo las recientes:
  // una baja o un «contactado» de hace dos meses sigue valiendo.
  const [draftFlags, calcFlags, clients, clientUsers, history] = await Promise.all([
    prisma.publicDraftRequest.findMany({
      where: { OR: byEmail },
      select: { contact: true, unsubscribedAt: true, contactedAt: true },
    }),
    prisma.calculatorLead.findMany({
      where: { OR: byEmail },
      select: { contact: true, unsubscribedAt: true, contactedAt: true },
    }),
    prisma.chatbotClient.findMany({
      where: { OR: emails.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })) },
      select: { email: true },
    }),
    prisma.chatbotClientUser.findMany({
      where: { OR: emails.map((e) => ({ nextAuthEmail: { equals: e, mode: 'insensitive' as const } })) },
      select: { nextAuthEmail: true },
    }),
    prisma.inboundFollowUpEmail.findMany({
      where: { email: { in: emails } },
      select: { source: true, sourceId: true, email: true, step: true, status: true, sentAt: true },
    }),
  ]);

  const unsubscribed = new Set<string>();
  const contacted = new Set<string>();
  for (const row of [...draftFlags, ...calcFlags]) {
    const e = emailFromContact(row.contact);
    if (!e) continue;
    if (row.unsubscribedAt) unsubscribed.add(e);
    if (row.contactedAt) contacted.add(e);
  }
  const isClient = new Set<string>([
    ...clients.map((c) => c.email.toLowerCase()),
    ...clientUsers.map((u) => u.nextAuthEmail.toLowerCase()),
  ]);
  // El hueco mínimo entre correos es por persona, no por petición: si pasó de
  // la calculadora al borrador, no recibe el día 0 del borrador al día
  // siguiente del día 0 de la calculadora.
  const lastSentByEmail = new Map<string, Date>();
  const doneBySource = new Map<string, Set<string>>();
  for (const h of history) {
    const key = `${h.source}:${h.sourceId}`;
    if (!doneBySource.has(key)) doneBySource.set(key, new Set());
    doneBySource.get(key)!.add(h.step);
    if (h.status === 'sent' && h.sentAt) {
      const prev = lastSentByEmail.get(h.email);
      if (!prev || h.sentAt > prev) lastSentByEmail.set(h.email, h.sentAt);
    }
  }

  // Una persona puede haber pedido dos borradores, o borrador y calculadora:
  // recibe UNA secuencia, la de su petición más reciente. Las anteriores se
  // sellan para que no arranquen en paralelo.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = groups.get(c.email) ?? [];
    list.push(c);
    groups.set(c.email, list);
  }

  const webPriceCents = await readWebPriceCents(prisma);
  let sendsThisSweep = 0;

  for (const [email, list] of groups) {
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const [primary, ...older] = list;

    for (const old of older) {
      const done = doneBySource.get(`${old.source}:${old.id}`) ?? new Set<string>();
      const pending = FOLLOW_UP_STEPS.map((s) => s.key).filter((k) => !done.has(k));
      result.skipped += await sealSkipped(prisma, old, pending, 'superseded');
    }

    const stop = followUpStopReason({
      unsubscribed: unsubscribed.has(email),
      isClient: isClient.has(email),
      contacted: contacted.has(email),
    });
    if (stop) {
      result.stopped += 1;
      continue;
    }

    const done = new Set(doneBySource.get(`${primary.source}:${primary.id}`) ?? []);
    // 30/10/2026 — el día 0 de un borrador es el correo que lo entrega
    // (public-draft-delivery.ts), no uno de esta secuencia: aquí nunca se
    // manda, aunque esa entrega no haya dejado fila (salió sin consentimiento,
    // o falló y el operador ya lo sabe por la cola).
    if (primary.source === 'web_draft') done.add('dia_0');
    const decision = nextFollowUpStep(
      { createdAt: primary.createdAt, done, lastSentAt: lastSentByEmail.get(email) ?? null },
      now,
    );
    if (decision.skip.length > 0) {
      result.skipped += await sealSkipped(prisma, primary, decision.skip, 'not_due');
    }
    if (!decision.send || sendsThisSweep >= MAX_SENDS_PER_SWEEP) continue;

    const outcome = await sendStep(prisma, primary, decision.send, base, webPriceCents, now);
    if (outcome === 'sent') {
      result.sent += 1;
      sendsThisSweep += 1;
    } else if (outcome === 'failed') {
      result.failed += 1;
      sendsThisSweep += 1;
    }
  }

  return result;
}

async function sealSkipped(
  prisma: PrismaClient,
  c: Candidate,
  steps: string[],
  reason: string,
): Promise<number> {
  if (steps.length === 0) return 0;
  const res = await prisma.inboundFollowUpEmail.createMany({
    data: steps.map((step) => ({ source: c.source, sourceId: c.id, email: c.email, step, status: 'skipped', error: reason })),
    skipDuplicates: true,
  });
  return res.count;
}

export async function readWebPriceCents(prisma: PrismaClient): Promise<number | null> {
  try {
    const web = await prisma.product.findFirst({
      where: { code: 'web', isActive: true, kind: 'plan' },
      orderBy: { setupFeeCents: 'asc' },
      select: { setupFeeCents: true },
    });
    return web && web.setupFeeCents > 0 ? web.setupFeeCents : null;
  } catch {
    return null;
  }
}

async function sendStep(
  prisma: PrismaClient,
  c: Candidate,
  step: FollowUpStepKey,
  base: string,
  webPriceCents: number | null,
  now: Date,
): Promise<'sent' | 'failed' | 'claimed_elsewhere'> {
  // Reservar antes de mandar: si otro barrido ya lo reservó, la clave única
  // salta y este no manda nada.
  let claimId: string;
  try {
    const claim = await prisma.inboundFollowUpEmail.create({
      data: { source: c.source, sourceId: c.id, email: c.email, step, status: 'sending' },
      select: { id: true },
    });
    claimId = claim.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'claimed_elsewhere';
    throw err;
  }

  let token = c.unsubscribeToken;
  if (!token) {
    token = newUnsubscribeToken();
    if (c.source === 'web_draft') {
      await prisma.publicDraftRequest.update({ where: { id: c.id }, data: { unsubscribeToken: token } });
    } else {
      await prisma.calculatorLead.update({ where: { id: c.id }, data: { unsubscribeToken: token } });
    }
  }

  const unsubscribeUrl = `${base}/api/public/baja/${token}`;
  const email = buildFollowUpEmail(step, c.contact, {
    unsubscribeUrl,
    contactUrl: 'https://kairikos.com/contacto/',
    whatsappUrl: supportWhatsappUrl('Hola, vengo de kairikos.com'),
    webPriceCents,
    recallOnSale: RECALL_ON_SALE,
    recallUrl: 'https://kairikos.com/llamadas/',
  });

  const error = await deliverInboundEmail(c.email, email, unsubscribeUrl);
  await prisma.inboundFollowUpEmail.update({
    where: { id: claimId },
    data: error ? { status: 'failed', error: error.slice(0, 500) } : { status: 'sent', sentAt: now },
  });
  return error ? 'failed' : 'sent';
}

/** Devuelve null si salió, o el motivo si no. Sin enlace de baja es un correo
 *  de servicio (el borrador que pidió, public-draft-delivery.ts) y no lleva la
 *  cabecera List-Unsubscribe. */
export async function deliverInboundEmail(
  to: string,
  email: { subject: string; text: string },
  unsubscribeUrl: string | null,
): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return 'no_api_key';
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const sent = await resend.emails.send({
      from: notifyFromAddress(),
      to: [to],
      replyTo: KAIRIKOS_CONTACT_EMAIL,
      subject: email.subject,
      text: email.text,
      ...(unsubscribeUrl
        ? {
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
    });
    if (sent.error) {
      logError('inbound_follow_up.send_failed', new Error(sent.error.message), { to }, 'warn');
      return sent.error.message;
    }
    return null;
  } catch (err) {
    logError('inbound_follow_up.send_failed', err, { to }, 'warn');
    return err instanceof Error ? err.message : 'unknown';
  }
}
