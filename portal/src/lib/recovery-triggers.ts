import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 3 — el motor de disparadores de recuperación.
//
// Un disparador es una consulta parametrizada sobre Contact + Job +
// ServiceQuote que contesta "¿a quién habría que volver a escribir, y por
// qué". Es el corazón del módulo de recuperación.
//
// ESTE MÓDULO NO ENVÍA NADA, Y ES A PROPÓSITO.
//
// Devuelve candidatos. El envío lo hace el motor de campañas, que ya
// existe para prospección. Separarlos permite ejecutar los disparadores en
// seco tantas veces como haga falta —en tests, en un panel, en una
// revisión manual antes de la primera campaña real— sin la menor
// posibilidad de que se le escriba a nadie por accidente.
//
// LAS REGLAS DE EXCLUSIÓN NO SON CONFIGURABLES, Y SE APLICAN SIEMPRE.
//
// Esa es la decisión de diseño que sostiene todo lo demás. No hay forma de
// pedir candidatos "sin filtrar": `findRecoveryCandidates` es la única
// salida y las exclusiones van dentro. Un parámetro `skipExclusions`, por
// muy cómodo que resultara en un test, sería la puerta por la que un día
// sale una campaña a alguien que pidió la baja.
//
// Y CADA EXCLUSIÓN SE DEVUELVE CON SU MOTIVO. Ante una reclamación, "a esa
// persona no se le escribió" es una afirmación que hay que poder
// demostrar, y un contacto que simplemente no aparece en una lista no
// demuestra nada. Por eso el resultado trae las dos mitades.
//
// DÓNDE VIVE CADA COMPROBACIÓN, QUE NO ES OBVIO
//
//   base legal    → Contact.legalBasis, sellado por la Fase 0 cuando el
//                   aviso de oposición SALIÓ de verdad.
//   supresión     → RecallBlockedNumber, que es donde ya la consultan el
//                   webhook de voz y el envío. No se duplica aquí.
//   contacto
//   reciente      → OutboundMessage, el libro mayor de la Fase 0. Es el
//                   pago inesperado de aquella tabla: sin una fila por
//                   envío, "¿cuándo le escribimos por última vez?" no
//                   tendría respuesta y esta exclusión sería inaplicable.
// =============================================================================

/** Los disparadores que hoy tienen datos detrás. Ver el final del fichero
 *  para los que el documento pide y todavía no se pueden calcular. */
export type RecoveryTrigger = 'open_quote' | 'service_anniversary' | 'dormant';

export type ExclusionReason =
  | 'no_legal_basis'
  | 'legal_basis_stale'
  | 'suppressed'
  | 'contacted_recently'
  | 'callback_scheduled';

/**
 * Cuánto tiempo se respeta a alguien tras escribirle.
 *
 * Treinta días. El documento lo dejaba como decisión pendiente y este es
 * el valor elegido: es el estándar del sector para marketing por mensaje,
 * y sobre todo es más largo que cualquier cadencia de disparador que se
 * vaya a configurar, así que hace de tope real y no de formalidad.
 */
export const RECENT_CONTACT_DAYS = 30;

/**
 * Caducidad de la base legal.
 *
 * Veinticuatro meses, que es la referencia habitual de la guía del ICO
 * para considerar "razonablemente reciente" un contacto obtenido por soft
 * opt-in. Pasado ese plazo el contacto sigue existiendo y se le puede
 * devolver una llamada; lo que caduca es meterlo en una campaña.
 */
export const MAX_LEGAL_BASIS_MONTHS = 24;

/** Un presupuesto se persigue a partir de la semana y hasta los seis
 *  meses. Antes es agobiar; después ya no es un presupuesto abierto, es
 *  arqueología. */
export const OPEN_QUOTE_MIN_DAYS = 7;
export const OPEN_QUOTE_MAX_DAYS = 180;

/** Sin trato en año y medio. */
export const DORMANT_MONTHS = 18;

/** Cuánta antelación se le da a una revisión que toca. */
export const ANNIVERSARY_WINDOW_DAYS = 30;

export interface RecoveryCandidate {
  contactId: string;
  e164: string;
  name: string | null;
  trigger: RecoveryTrigger;
  /** Para el mensaje y para el panel: "presupuesto de 1.400 € de hace 34 días". */
  reason: string;
  jobId?: string;
  serviceQuoteId?: string;
  amount?: number | null;
}

export interface RecoveryExclusion {
  contactId: string;
  e164: string;
  trigger: RecoveryTrigger;
  reason: ExclusionReason;
}

export interface RecoveryRun {
  candidates: RecoveryCandidate[];
  /** Auditable: por qué NO se le escribió a cada uno. */
  excluded: RecoveryExclusion[];
}

// ---------------------------------------------------------------------------
// La decisión, aislada y pura
// ---------------------------------------------------------------------------

export interface ExclusionContext {
  legalBasis: string | null;
  legalBasisCapturedAt: Date | null;
  isSuppressed: boolean;
  lastContactedAt: Date | null;
  hasScheduledCallback: boolean;
  now: Date;
}

function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

/**
 * ¿Por qué NO se le puede escribir a este contacto? `null` = se puede.
 *
 * Función pura y exportada para poder probar las combinaciones sin tocar
 * la red ni la base, que es el mismo motivo por el que se aíslan los
 * parseos de las integraciones de IA.
 *
 * EL ORDEN IMPORTA: se devuelve el motivo MÁS GRAVE, no el primero que
 * aparezca. A quien pidió la baja se le excluye por la baja, aunque
 * además lleve dos años sin base legal válida — porque es la respuesta
 * que hay que dar si alguien pregunta.
 */
export function exclusionFor(ctx: ExclusionContext): ExclusionReason | null {
  // 1. La baja, por encima de todo.
  if (ctx.isSuppressed) return 'suppressed';

  // 2. Nunca se le dio la opción de oponerse: no hay base para escribirle.
  if (ctx.legalBasis === null) return 'no_legal_basis';

  // 3. Se le dio, pero hace demasiado.
  if (
    ctx.legalBasisCapturedAt === null ||
    ctx.legalBasisCapturedAt < monthsBefore(ctx.now, MAX_LEGAL_BASIS_MONTHS)
  ) {
    return 'legal_basis_stale';
  }

  // 4. Ya hay una conversación viva: escribirle ahora es interrumpir.
  if (ctx.hasScheduledCallback) return 'callback_scheduled';

  // 5. Descanso entre mensajes.
  if (ctx.lastContactedAt !== null) {
    const cutoff = new Date(ctx.now.getTime() - RECENT_CONTACT_DAYS * 24 * 60 * 60 * 1000);
    if (ctx.lastContactedAt > cutoff) return 'contacted_recently';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Los disparadores
// ---------------------------------------------------------------------------

interface RawCandidate {
  contactId: string;
  e164: string;
  name: string | null;
  legalBasis: string | null;
  legalBasisCapturedAt: Date | null;
  trigger: RecoveryTrigger;
  reason: string;
  jobId?: string;
  serviceQuoteId?: string;
  amount?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function formatAmount(amount: number | null): string {
  if (amount === null) return 'sin importe';
  return `${amount.toLocaleString('es-ES', { maximumFractionDigits: 0 })} €`;
}

async function openQuoteCandidates(
  prisma: PrismaClient,
  clientId: string,
  now: Date,
): Promise<RawCandidate[]> {
  const rows = await prisma.serviceQuote.findMany({
    where: {
      clientId,
      status: 'open',
      issuedAt: {
        lte: new Date(now.getTime() - OPEN_QUOTE_MIN_DAYS * DAY_MS),
        gte: new Date(now.getTime() - OPEN_QUOTE_MAX_DAYS * DAY_MS),
      },
      // Sin contacto no hay a quién escribir. Ver la cabecera de Job.
      contactId: { not: null },
      // Perseguido una vez, no dos.
      lastFollowedUpAt: null,
    },
    select: {
      id: true,
      amount: true,
      issuedAt: true,
      contact: {
        select: { id: true, e164: true, name: true, legalBasis: true, legalBasisCapturedAt: true },
      },
    },
  });

  return rows.flatMap((q) => {
    if (!q.contact) return [];
    const amount = q.amount === null ? null : Number(q.amount);
    return [
      {
        contactId: q.contact.id,
        e164: q.contact.e164,
        name: q.contact.name,
        legalBasis: q.contact.legalBasis,
        legalBasisCapturedAt: q.contact.legalBasisCapturedAt,
        trigger: 'open_quote' as const,
        reason: `presupuesto de ${formatAmount(amount)} de hace ${daysBetween(q.issuedAt, now)} días`,
        serviceQuoteId: q.id,
        amount,
      },
    ];
  });
}

async function anniversaryCandidates(
  prisma: PrismaClient,
  clientId: string,
  now: Date,
): Promise<RawCandidate[]> {
  const rows = await prisma.job.findMany({
    where: {
      clientId,
      contactId: { not: null },
      nextServiceDueAt: {
        not: null,
        lte: new Date(now.getTime() + ANNIVERSARY_WINDOW_DAYS * DAY_MS),
      },
    },
    select: {
      id: true,
      serviceType: true,
      nextServiceDueAt: true,
      contact: {
        select: { id: true, e164: true, name: true, legalBasis: true, legalBasisCapturedAt: true },
      },
    },
  });

  return rows.flatMap((j) => {
    if (!j.contact || !j.nextServiceDueAt) return [];
    const what = j.serviceType ?? 'la revisión';
    return [
      {
        contactId: j.contact.id,
        e164: j.contact.e164,
        name: j.contact.name,
        legalBasis: j.contact.legalBasis,
        legalBasisCapturedAt: j.contact.legalBasisCapturedAt,
        trigger: 'service_anniversary' as const,
        reason: `toca ${what} (vence ${j.nextServiceDueAt.toISOString().slice(0, 10)})`,
        jobId: j.id,
      },
    ];
  });
}

async function dormantCandidates(
  prisma: PrismaClient,
  clientId: string,
  now: Date,
): Promise<RawCandidate[]> {
  const rows = await prisma.contact.findMany({
    where: {
      clientId,
      lastInteractionAt: { lt: monthsBefore(now, DORMANT_MONTHS) },
    },
    select: {
      id: true,
      e164: true,
      name: true,
      legalBasis: true,
      legalBasisCapturedAt: true,
      lastInteractionAt: true,
    },
  });

  return rows.map((c) => ({
    contactId: c.id,
    e164: c.e164,
    name: c.name,
    legalBasis: c.legalBasis,
    legalBasisCapturedAt: c.legalBasisCapturedAt,
    trigger: 'dormant' as const,
    reason: `sin trato desde hace ${Math.floor(daysBetween(c.lastInteractionAt, now) / 30)} meses`,
  }));
}

const TRIGGERS: Record<
  RecoveryTrigger,
  (prisma: PrismaClient, clientId: string, now: Date) => Promise<RawCandidate[]>
> = {
  open_quote: openQuoteCandidates,
  service_anniversary: anniversaryCandidates,
  dormant: dormantCandidates,
};

export interface FindCandidatesOptions {
  clientId: string;
  /** Para consultar la lista de supresión, que está por suscripción. */
  subscriptionId: string;
  /** Qué disparadores evaluar. Por defecto, todos. */
  triggers?: readonly RecoveryTrigger[];
  now?: Date;
}

/**
 * Quién está listo para una campaña de recuperación, y quién no y por qué.
 *
 * ÚNICA SALIDA DE ESTE MÓDULO, y sin forma de saltarse las exclusiones.
 * Ver la cabecera: la comodidad de un `skipExclusions` no compensa ser la
 * puerta por la que un día sale un mensaje a quien pidió la baja.
 *
 * Un contacto puede aparecer en dos disparadores a la vez (un presupuesto
 * abierto Y una revisión que vence) y aquí sale dos veces: deduplicar es
 * decisión del motor de campañas, que es quien sabe cuál de los dos
 * mensajes tiene más valor. Este módulo informa, no prioriza.
 */
export async function findRecoveryCandidates(
  prisma: PrismaClient,
  opts: FindCandidatesOptions,
): Promise<RecoveryRun> {
  const now = opts.now ?? new Date();
  const wanted = opts.triggers ?? (Object.keys(TRIGGERS) as RecoveryTrigger[]);

  const raw: RawCandidate[] = [];
  for (const trigger of wanted) {
    raw.push(...(await TRIGGERS[trigger](prisma, opts.clientId, now)));
  }
  if (raw.length === 0) return { candidates: [], excluded: [] };

  const numbers = [...new Set(raw.map((r) => r.e164))];

  // Las tres consultas de exclusión, una vez para todos los candidatos en
  // vez de una por contacto: un barrido de dos mil contactos con tres
  // consultas cada uno son seis mil viajes a Postgres.
  const [suppressed, recentlyContacted, scheduledCallbacks] = await Promise.all([
    prisma.recallBlockedNumber.findMany({
      where: { subscriptionId: opts.subscriptionId, e164: { in: numbers } },
      select: { e164: true },
    }),
    prisma.outboundMessage.findMany({
      where: {
        clientId: opts.clientId,
        toE164: { in: numbers },
        ok: true,
        sentAt: { gt: new Date(now.getTime() - RECENT_CONTACT_DAYS * DAY_MS) },
      },
      select: { toE164: true, sentAt: true },
      orderBy: { sentAt: 'desc' },
    }),
    prisma.callEvent.findMany({
      where: { clientId: opts.clientId, callbackSlotAt: { gt: now } },
      select: { contactId: true },
    }),
  ]);

  const suppressedSet = new Set(suppressed.map((s) => s.e164));
  const callbackSet = new Set(scheduledCallbacks.map((c) => c.contactId).filter(Boolean) as string[]);
  const lastContact = new Map<string, Date>();
  for (const row of recentlyContacted) {
    // Ordenado desc, así que el primero de cada número es el más reciente.
    if (!lastContact.has(row.toE164)) lastContact.set(row.toE164, row.sentAt);
  }

  const candidates: RecoveryCandidate[] = [];
  const excluded: RecoveryExclusion[] = [];

  for (const r of raw) {
    const reason = exclusionFor({
      legalBasis: r.legalBasis,
      legalBasisCapturedAt: r.legalBasisCapturedAt,
      isSuppressed: suppressedSet.has(r.e164),
      lastContactedAt: lastContact.get(r.e164) ?? null,
      hasScheduledCallback: callbackSet.has(r.contactId),
      now,
    });

    if (reason) {
      excluded.push({ contactId: r.contactId, e164: r.e164, trigger: r.trigger, reason });
      continue;
    }

    candidates.push({
      contactId: r.contactId,
      e164: r.e164,
      name: r.name,
      trigger: r.trigger,
      reason: r.reason,
      ...(r.jobId ? { jobId: r.jobId } : {}),
      ...(r.serviceQuoteId ? { serviceQuoteId: r.serviceQuoteId } : {}),
      ...(r.amount !== undefined ? { amount: r.amount } : {}),
    });
  }

  return { candidates, excluded };
}

// =============================================================================
// Los disparadores que el documento pide y que TODAVÍA NO SE PUEDEN
// CALCULAR. No están omitidos: están esperando un dato que aún no existe.
//
//   equipment_age  — necesita Job.equipment.installedYear poblado. La
//                    columna existe (Fase 2) pero solo la rellena la
//                    captura por voz, así que hasta que haya trabajos
//                    capturados de verdad este disparador devolvería cero
//                    filas siempre, que es peor que no tenerlo: parecería
//                    que funciona.
//
//   seasonal       — necesita un calendario por país y por gremio, que es
//                    configuración de negocio y no de código. Se construye
//                    cuando haya un segundo gremio: con uno solo, "antes
//                    del invierno" es una fecha escrita a mano.
//
//   cross_sell     — necesita serviceType normalizado por gremio. Hoy es
//                    texto libre dictado por voz ("cambio de termo",
//                    "sustitución del termo"), y agrupar eso a ciegas
//                    daría recomendaciones absurdas. El propio documento
//                    avisa: automatizar solo lo que se repitió idéntico en
//                    tres clientes seguidos.
// =============================================================================
