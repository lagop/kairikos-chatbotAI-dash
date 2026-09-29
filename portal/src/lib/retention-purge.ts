import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';

// =============================================================================
// El borrado por plazo de conservación — lo que hace verdad la política de
// privacidad publicada el 29/09/2026 en kairikos.com/privacidad/.
//
// Esa política promete tres cosas con plazo, y hasta este módulo ninguna
// tenía código detrás:
//
//   * Herramientas gratuitas (calculadora, borrador de web): «datos de
//     contacto: hasta tres años desde el último contacto».
//   * Prospección propia: «hasta tres años desde que se obtuvieron, o hasta
//     que te opongas, lo que ocurra antes».
//
// QUÉ SE TOCA Y QUÉ NO. Solo lo que Kairikos trata como RESPONSABLE. Los leads
// que la prospección de un cliente encuentra para ese cliente son datos del
// cliente: Kairikos es su encargado, el contrato de encargo dice «mientras
// dure el servicio», y decidir cuándo se borran es del cliente, no nuestro.
// Por eso la prospección se filtra por `ChatbotClient.isInternal`: una cuenta
// interna es una cuenta de Kairikos, y lo que prospecta, Kairikos lo prospecta
// para sí. Se eligió eso frente a una variable de entorno con el id de la
// cuenta porque la variable necesitaría los cuatro sitios de la trampa 2 de
// CLAUDE.md y ya existe el interruptor que dice exactamente esto.
//
// LIMITACIÓN CONOCIDA: `contacto@kairikos.com`, la cuenta que lleva la
// campaña de prospección propia, NO está marcada como interna a 29/09/2026.
// Hasta que se marque, la parte de prospección no encuentra nada que tocar.
// No es un fallo de este módulo; es el interruptor de la ficha del cliente.
//
// LA OPOSICIÓN NO ES UN BORRADO. Si al que dijo «no» se le borrase entero, la
// siguiente búsqueda lo volvería a encontrar en Google Maps como un negocio
// nuevo y le escribiría otra vez: exactamente lo contrario de lo que pidió.
// Así que se reduce al mínimo imprescindible para no volver a contactarle
// —el teléfono, que es con lo que prospecting-contact.ts bloquea, y el id de
// Google, que es con lo que la ingesta deduplica— y se borra todo lo demás.
// Es el sistema de exclusión del art. 23 LOPDGDD, y ese resto se conserva
// SIN plazo, porque su única finalidad es cumplir la oposición: por eso el
// borrado a tres años se salta esos leads.
//
// «Se opuso» es hoy lo que marca prospecting-replies.ts cuando el prospecto
// contesta pidiendo la baja: status 'descartado' Y repliedAt. Un descarte a
// mano del operador NO cuenta —puede ser «no encaja», no «no me escribas»—.
// Si alguien se opone por teléfono o por correo, hoy no hay botón para
// registrarlo: es la limitación conocida de la otra mitad.
//
// Idempotente, como exige el scheduler, que lo llama cada cinco minutos: cada
// paso busca solo lo que aún le queda por hacer, así que la segunda llamada
// del día no encuentra nada. Que corra cada cinco minutos y no una vez al día
// es a propósito: la oposición se cumple en minutos, no al día siguiente.
// =============================================================================

export const TOOL_CONTACT_RETENTION_YEARS = 3;
export const OWN_PROSPECT_RETENTION_YEARS = 3;

/** Tope de leads por pasada. El borrado de las herramientas es un único
 *  DELETE y no lo necesita; el de leads pasa por dos tablas y va acotado para
 *  que un atasco de años no se coma el presupuesto de la petición. */
export const LEAD_BATCH_LIMIT = 500;

/** Lo que dice el actorId del rastro de auditoría cuando este módulo toca un
 *  lead. Misma convención que 'system:prospecting'. */
export const RETENTION_ACTOR_ID = 'system:retention';

export interface RetentionPurgeResult {
  calculatorLeadsDeleted: number;
  draftRequestsDeleted: number;
  ownProspectsDeleted: number;
  ownProspectsMinimized: number;
}

/**
 * La fecha antes de la cual algo ha cumplido su plazo. Años de calendario,
 * no 365 días: «tres años» en la política se lee como el mismo día tres años
 * antes, y con bisiestos por medio la diferencia es de un día.
 */
export function retentionCutoff(now: Date, years: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff;
}

/**
 * «Desde el último contacto»: el último contacto es `contactedAt` si alguien
 * del equipo le llegó a contactar, y si no, la fecha en que nos dejó el dato.
 * Un contacto reciente reinicia el plazo, por eso las dos fechas tienen que
 * haber vencido.
 */
function lastContactBefore(cutoff: Date) {
  return {
    createdAt: { lt: cutoff },
    OR: [{ contactedAt: null }, { contactedAt: { lt: cutoff } }],
  };
}

/** El prospecto pidió que no se le escriba más. Ver la cabecera. */
const OPPOSED: Prisma.LeadWhereInput = { status: 'descartado', repliedAt: { not: null } };

const OWN_PROSPECT: Prisma.LeadWhereInput = {
  source: 'outbound',
  client: { isInternal: true },
};

/**
 * Lo que queda de un prospecto que se opuso, y por qué cada cosa:
 *   - contactPhone: prospecting-contact.ts bloquea por teléfono.
 *   - externalPlaceId: la ingesta deduplica por él; sin él vuelve a entrar.
 *   - status, repliedAt, discardedAt: son la propia marca de oposición.
 *   - searchCategory, searchLocation, primaryType: el rubro y la zona de la
 *     búsqueda, que no identifican a nadie.
 * Todo lo demás se vacía.
 */
const MINIMIZED_LEAD_FIELDS = {
  contactName: null,
  contactEmail: null,
  summary: null,
  score: null,
  scoreReason: null,
  website: null,
  latitude: null,
  longitude: null,
} satisfies Prisma.LeadUpdateManyMutationInput;

/** Queda algo por vaciar. Es lo que hace idempotente la minimización. */
const NOT_YET_MINIMIZED: Prisma.LeadWhereInput = {
  OR: [
    ...Object.keys(MINIMIZED_LEAD_FIELDS).map((field) => ({ [field]: { not: null } })),
    { webDraft: { isNot: null } },
    { competitorSnapshot: { isNot: null } },
  ],
};

async function purgeToolContacts(prisma: PrismaClient, now: Date) {
  const where = lastContactBefore(retentionCutoff(now, TOOL_CONTACT_RETENTION_YEARS));
  // Se borra la fila entera, no solo `contact`: el nombre del negocio y la
  // ciudad de un autónomo también le identifican, y lo que no identifica de
  // estas herramientas (las cachés de «¿Qué vendes?», la auditoría pública y
  // la competencia por zona) vive en otras tablas que no guardan contactos.
  const [calculator, drafts] = await prisma.$transaction([
    prisma.calculatorLead.deleteMany({ where }),
    prisma.publicDraftRequest.deleteMany({ where }),
  ]);
  return { calculatorLeadsDeleted: calculator.count, draftRequestsDeleted: drafts.count };
}

async function minimizeOpposedProspects(prisma: PrismaClient, now: Date): Promise<number> {
  const leads = await prisma.lead.findMany({
    where: { AND: [OWN_PROSPECT, OPPOSED, NOT_YET_MINIMIZED] },
    select: { id: true, clientId: true, tenantId: true, status: true },
    orderBy: { createdAt: 'asc' },
    take: LEAD_BATCH_LIMIT,
  });
  if (leads.length === 0) return 0;
  const ids = leads.map((l) => l.id);

  await prisma.$transaction([
    // El informe de competencia y el borrador de web de este negocio llevan
    // su nombre, su web y sus reseñas; sin el lead ya no sirven para nada.
    prisma.prospectingCompetitorSnapshot.deleteMany({ where: { leadId: { in: ids } } }),
    prisma.prospectingWebDraft.deleteMany({ where: { leadId: { in: ids } } }),
    prisma.lead.updateMany({ where: { id: { in: ids } }, data: MINIMIZED_LEAD_FIELDS }),
    // Las auditorías son append-only: esta fila es la que deja escrito por
    // qué el lead aparece vacío de repente.
    prisma.leadAudit.createMany({
      data: leads.map((l) => ({
        leadId: l.id,
        clientId: l.clientId,
        tenantId: l.tenantId,
        action: 'minimized_opposition',
        statusBefore: l.status,
        statusAfter: l.status,
        actorId: RETENTION_ACTOR_ID,
        changedAt: now,
      })),
    }),
  ]);
  return ids.length;
}

async function deleteExpiredOwnProspects(prisma: PrismaClient, now: Date): Promise<number> {
  const cutoff = retentionCutoff(now, OWN_PROSPECT_RETENTION_YEARS);
  const leads = await prisma.lead.findMany({
    where: { AND: [OWN_PROSPECT, { createdAt: { lt: cutoff } }, { NOT: OPPOSED }] },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: LEAD_BATCH_LIMIT,
  });
  if (leads.length === 0) return 0;
  const ids = leads.map((l) => l.id);

  await prisma.$transaction([
    // LeadAudit apunta al lead con onDelete: Restrict, a propósito, para que
    // nadie borre un lead por accidente y se lleve su historia. Aquí el
    // borrado ES la finalidad, así que su historia se va con él: dejar el
    // rastro sería conservar que existió, que es lo que el plazo prohíbe.
    // El informe y el borrador caen solos (onDelete: Cascade); las llamadas
    // de recall quedan sin lead (SetNull), que son de otro tratamiento.
    prisma.leadAudit.deleteMany({ where: { leadId: { in: ids } } }),
    prisma.lead.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

/**
 * Una pasada completa. Lanza si falla la base de datos; la ruta de cron lo
 * recoge. No hay nada «best-effort» aquí: un borrado que falla en silencio es
 * una promesa de la política que deja de cumplirse sin que nadie lo sepa.
 */
export async function runRetentionPurge(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<RetentionPurgeResult> {
  const tools = await purgeToolContacts(prisma, now);
  // La oposición va antes que el plazo: un lead que se opuso y además tiene
  // más de tres años tiene que quedar minimizado, no borrado.
  const ownProspectsMinimized = await minimizeOpposedProspects(prisma, now);
  const ownProspectsDeleted = await deleteExpiredOwnProspects(prisma, now);
  return { ...tools, ownProspectsMinimized, ownProspectsDeleted };
}
