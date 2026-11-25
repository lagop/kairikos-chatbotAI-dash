import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';

// =============================================================================
// RGPD, encargo del tratamiento (25/11/2026) — el rastro de lo que se hace
// con los datos que tratamos POR CUENTA del cliente: chat, llamadas y
// solicitudes. Ver el comentario del modelo ClientDataAudit en el esquema y
// docs/datos-de-clientes-rgpd.md.
//
// Lo escriben las exportaciones (PR 1 y 2 del plan), y lo escribirán la
// retención de conversaciones (PR 4) y la baja (PR 5). Append-only.
//
// `metadata` tiene una forma cerrada a propósito: recuentos, formato, fechas
// y cortes. El tipo impide meter ahí un nombre, un teléfono o un texto del
// visitante — una auditoría que copia los datos que se exportaron o se
// borraron deja una copia más que nadie va a purgar.
// =============================================================================

export const CLIENT_DATA_PRODUCT_CODES = ['chatbot', 'recall', 'leads'] as const;
export type ClientDataProductCode = (typeof CLIENT_DATA_PRODUCT_CODES)[number];

export const CLIENT_DATA_ACTIONS = [
  'exported',
  'retention_dry_run',
  'retention_purged',
  'exit_notified',
  'exit_purged',
] as const;
export type ClientDataAction = (typeof CLIENT_DATA_ACTIONS)[number];

/** 'client:<clientId>' | 'operator:<operatorId>' | 'system:<job>' */
export type ClientDataActor = `client:${string}` | `operator:${string}` | `system:${string}`;

export type ExportFormat = 'csv' | 'json';

/** Solo recuentos, formato, fechas y cortes. Nunca datos personales. */
export interface ClientDataAuditMetadata {
  format?: ExportFormat;
  /** Filas principales: conversaciones, llamadas o solicitudes. */
  count?: number;
  /** Turnos de conversación, cuando aplica. */
  turns?: number;
  /** Corte de una retención (ISO 8601). */
  cutoff?: string;
  retentionDays?: number;
  /** Fecha de referencia de una baja (ISO 8601). */
  noticeAt?: string;
}

export interface ClientDataAuditInput {
  clientId: string;
  clientProductId?: string | null;
  tenantId?: string | null;
  productCode: ClientDataProductCode;
  action: ClientDataAction;
  actor: ClientDataActor;
  metadata: ClientDataAuditMetadata;
}

type AuditWriter = Pick<PrismaClient, 'clientDataAudit'> | Pick<Prisma.TransactionClient, 'clientDataAudit'>;

/** Quita las claves sin valor: `undefined` no viaja en JSON y es ruido. */
function compactMetadata(metadata: ClientDataAuditMetadata): Prisma.InputJsonObject {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null) out[key] = value as string | number;
  }
  return out;
}

/**
 * Escribe una fila. Lanza si la base de datos falla, y es lo que se quiere:
 * una exportación sin rastro es justo lo que esta tabla existe para impedir,
 * así que las rutas la llaman ANTES de empezar a mandar el fichero y, si
 * falla, no hay fichero.
 */
export async function recordClientDataAudit(prisma: AuditWriter, input: ClientDataAuditInput): Promise<void> {
  await prisma.clientDataAudit.create({
    data: {
      clientId: input.clientId,
      clientProductId: input.clientProductId ?? null,
      tenantId: input.tenantId ?? null,
      productCode: input.productCode,
      action: input.action,
      actor: input.actor,
      metadata: compactMetadata(input.metadata),
    },
  });
}

/** `?formato=csv|json` (también `format`, por si alguien lo escribe en inglés).
 *  Sin parámetro, CSV: es lo que abre el cliente. Cualquier otro valor es un
 *  400, no un CSV silencioso que no era lo que pidió. */
export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  if (raw === null || raw === undefined || raw === '') return 'csv';
  const value = raw.trim().toLowerCase();
  return value === 'csv' || value === 'json' ? value : null;
}
