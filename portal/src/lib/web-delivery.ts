import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 3 — seguimiento de la entrega del producto 'web'.
//
// El ciclo comercial estaba completo hasta el cobro y ahí se acababa el
// portal: el cliente pagaba y desaparecía la información. Es el hueco más
// visible que tiene, porque empieza justo cuando acaba de pagar — el
// momento en que más mira.
//
// **Las etapas son un catálogo fijo, no una lista que escribe el
// operador.** Dos motivos: el cliente tiene que poder responder «¿por
// dónde va lo mío?» de un vistazo, y eso exige que su proyecto se parezca
// a los demás; y un operador escribiendo etapas a mano acaba con un
// proyecto de cuatro pasos y otro de once, ninguno comparable. Mismo
// razonamiento que WIZARD_STEP_CATALOG.
//
// El progreso NO se guarda como «etapa actual» sino como una fila por
// etapa con su fecha. La diferencia importa cuando el cliente pregunta
// «¿cuándo terminasteis el diseño?»: con un puntero esa respuesta no
// existe, y es justo la que genera la llamada.
// =============================================================================

export interface WebMilestoneDefinition {
  key: string;
  /** Lo que ve el cliente. En su idioma, no en el nuestro: «Construcción»,
   *  no «development». */
  label: string;
  /** Qué pasa en esta etapa, para que no tenga que preguntarlo. */
  detail: string;
}

/**
 * Las cinco etapas de un proyecto web, en orden. El orden es el dato: es
 * lo que permite decir «vas por la tercera de cinco» sin guardar un número
 * que se desincronice del catálogo.
 */
export const WEB_MILESTONES: readonly WebMilestoneDefinition[] = Object.freeze([
  {
    key: 'brief',
    label: 'Contenido y objetivos',
    detail: 'Recogemos tus textos, fotos y lo que quieres conseguir con la web.',
  },
  {
    key: 'design',
    label: 'Diseño',
    detail: 'Preparamos cómo va a verse, y te lo enseñamos antes de construir nada.',
  },
  {
    key: 'build',
    label: 'Construcción',
    detail: 'Montamos la web con el diseño aprobado y tus contenidos.',
  },
  {
    key: 'review',
    label: 'Tu revisión',
    detail: 'Te damos un enlace privado para que la veas entera y nos digas qué cambiar.',
  },
  {
    key: 'launch',
    label: 'Publicación',
    detail: 'La ponemos en tu dominio y queda accesible para todo el mundo.',
  },
]);

export const MILESTONE_KEYS: readonly string[] = WEB_MILESTONES.map((m) => m.key);

/** 'pending' | 'in_progress' | 'done'. Texto libre con los valores
 *  documentados, como el resto de columnas de estado del esquema. */
export const MILESTONE_STATUSES = ['pending', 'in_progress', 'done'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export function isMilestoneKey(value: string): boolean {
  return MILESTONE_KEYS.includes(value);
}

export function isMilestoneStatus(value: string): value is MilestoneStatus {
  return (MILESTONE_STATUSES as readonly string[]).includes(value);
}

/**
 * Desde qué estado del presupuesto tiene sentido seguir la entrega.
 *
 * Antes de que haya dinero encima de la mesa no hay proyecto que seguir, y
 * enseñarle etapas a alguien que todavía no ha aceptado el presupuesto le
 * promete un trabajo que no se ha encargado.
 */
export function hasDeliveryTracking(quoteStatus: string): boolean {
  return ['deposit_paid', 'invoiced_final', 'paid'].includes(quoteStatus);
}

export interface MilestoneView {
  key: string;
  label: string;
  detail: string;
  status: MilestoneStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  note: string | null;
}

export interface DeliveryProgress {
  milestones: MilestoneView[];
  /** Etapas terminadas, para «3 de 5». */
  done: number;
  total: number;
  /** La etapa en curso, si la hay. Null cuando aún no ha empezado ninguna
   *  o cuando ya están todas. */
  current: MilestoneView | null;
}

interface MilestoneRow {
  key: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  note: string | null;
}

/**
 * Une el catálogo con lo guardado.
 *
 * Pura y exportada. El catálogo manda sobre el orden y las etiquetas, y
 * las filas solo aportan fechas y estado: así, añadir una etapa al
 * catálogo la hace aparecer en todos los proyectos como 'pending' sin
 * migrar nada, y una fila de una etapa que ya no existe se ignora en vez
 * de dibujar un paso fantasma.
 */
export function buildDeliveryProgress(rows: readonly MilestoneRow[]): DeliveryProgress {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const milestones: MilestoneView[] = WEB_MILESTONES.map((definition) => {
    const row = byKey.get(definition.key);
    const status = row && isMilestoneStatus(row.status) ? row.status : 'pending';
    return {
      key: definition.key,
      label: definition.label,
      detail: definition.detail,
      status,
      startedAt: row?.startedAt ?? null,
      completedAt: row?.completedAt ?? null,
      note: row?.note ?? null,
    };
  });

  return {
    milestones,
    done: milestones.filter((m) => m.status === 'done').length,
    total: milestones.length,
    current: milestones.find((m) => m.status === 'in_progress') ?? null,
  };
}

/**
 * Marca una etapa, creando su fila si es la primera vez.
 *
 * Se estampa `startedAt` al pasar a 'in_progress' y `completedAt` al pasar
 * a 'done', y ninguna se reescribe si ya estaba puesta: son el registro de
 * cuándo pasó cada cosa, y un operador que vuelve a pulsar el mismo botón
 * no debe mover una fecha que el cliente ya ha visto.
 */
export async function setMilestone(
  prisma: PrismaClient,
  input: {
    webQuoteId: string;
    clientId: string;
    tenantId: string | null;
    key: string;
    status: MilestoneStatus;
    note?: string | null;
    /** Email del operador, o 'client:<clientId>'. */
    actorId: string;
    actorType: 'operator' | 'client' | 'system';
    now?: Date;
  },
): Promise<{ ok: true } | { ok: false; error: 'unknown_milestone' }> {
  if (!isMilestoneKey(input.key)) return { ok: false, error: 'unknown_milestone' };
  const now = input.now ?? new Date();

  const existing = await prisma.webProjectMilestone.findUnique({
    where: { webQuoteId_key: { webQuoteId: input.webQuoteId, key: input.key } },
    select: { startedAt: true, completedAt: true },
  });

  const startedAt =
    existing?.startedAt ?? (input.status === 'in_progress' || input.status === 'done' ? now : null);
  const completedAt = existing?.completedAt ?? (input.status === 'done' ? now : null);

  await prisma.$transaction(async (tx) => {
    await tx.webProjectMilestone.upsert({
      where: { webQuoteId_key: { webQuoteId: input.webQuoteId, key: input.key } },
      create: {
        webQuoteId: input.webQuoteId,
        clientId: input.clientId,
        tenantId: input.tenantId,
        key: input.key,
        status: input.status,
        startedAt,
        completedAt,
        note: input.note ?? null,
      },
      update: {
        status: input.status,
        startedAt,
        completedAt,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });

    // WebQuoteAudit usa actorType/actorEmail, no un actorId genérico:
    // aquí escriben tanto el operador como el cliente (al aceptar la
    // entrega), y distinguirlos es el motivo de que esas columnas existan.
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: input.webQuoteId,
        action: 'milestone_updated',
        after: { key: input.key, status: input.status },
        actorType: input.actorType,
        ...(input.actorType === 'operator'
          ? { actorOperatorId: input.actorId }
          : { actorEmail: input.actorId }),
      },
    });
  });

  return { ok: true };
}
