import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 4 — salida de los leads hacia fuera del portal.
//
// Hasta ahora los leads se quedaban aquí. Para un negocio que ya tiene su
// CRM eso no es una funcionalidad que falte: es un motivo real para no
// renovar, porque le obligamos a copiar a mano lo que ya le hemos cobrado.
//
// Dos salidas, deliberadamente distintas:
//
//   • Este CSV, que resuelve el caso de hoy — «me lo llevo a Excel» — y no
//     necesita que el cliente configure nada.
//   • El webhook saliente (lead-webhook.ts), que resuelve el de mañana:
//     que sus leads aparezcan en su CRM sin que nadie los toque.
//
// El CSV se genera en memoria y se sirve entero. Un cliente con miles de
// leads produciría un fichero grande, pero el tope de clasificación mensual
// (LEADS_CLASSIFICATION_MONTHLY_CAP = 500) acota de hecho cuántos puede
// haber, y transmitir por trozos por un caso que este producto no permite
// tener sería complejidad sin caso.
// =============================================================================

/** Las columnas, en orden, con la cabecera que verá en su hoja de cálculo.
 *  En castellano: lo abre el cliente, no nosotros. */
export const LEAD_EXPORT_COLUMNS: ReadonlyArray<{ header: string; key: string }> = Object.freeze([
  { header: 'Fecha', key: 'createdAt' },
  { header: 'Nombre', key: 'contactName' },
  { header: 'Teléfono', key: 'contactPhone' },
  { header: 'Email', key: 'contactEmail' },
  { header: 'Estado', key: 'status' },
  { header: 'Origen', key: 'source' },
  { header: 'Canal', key: 'channel' },
  { header: 'Prioridad', key: 'score' },
  { header: 'Por qué esta prioridad', key: 'scoreReason' },
  { header: 'Resumen', key: 'summary' },
  { header: 'Web', key: 'website' },
  { header: 'Rubro buscado', key: 'searchCategory' },
  { header: 'Zona buscada', key: 'searchLocation' },
  { header: 'Contactado', key: 'contactedAt' },
  { header: 'Respondió', key: 'repliedAt' },
  { header: 'Convertido', key: 'convertedAt' },
]);

/**
 * Escapa un valor para CSV.
 *
 * Las comillas se duplican y el campo se entrecomilla en cuanto contiene
 * una coma, una comilla o un salto de línea — sin esto, un resumen con una
 * coma parte la fila y el cliente abre una hoja con las columnas
 * desplazadas, que es peor que no dársela.
 *
 * El apóstrofo delante de =, +, - y @ NO es decorativo: Excel interpreta un
 * campo que empieza por esos caracteres como una FÓRMULA. Un lead cuyo
 * nombre sea `=1+1` se ejecutaría al abrir el fichero, y hay cargas útiles
 * peores que esa. El texto lo escribe un desconocido por WhatsApp, así que
 * hay que asumir que alguien lo intentará.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<{ header: string; key: string }> = LEAD_EXPORT_COLUMNS,
): string {
  const lines = [columns.map((c) => escapeCsvValue(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvValue(row[c.key])).join(','));
  }
  // CRLF: es lo que espera Excel, que es donde acaba esto.
  return lines.join('\r\n');
}

/**
 * Los leads del cliente, listos para exportar.
 *
 * Sin ventana temporal ni paginación: el cliente pide «mis leads» y espera
 * los suyos, no los de los últimos treinta días. Ordenados del más
 * reciente al más antiguo, como los ve en pantalla.
 */
export async function loadLeadsForExport(
  prisma: PrismaClient,
  clientId: string,
): Promise<Record<string, unknown>[]> {
  return prisma.lead.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      status: true,
      source: true,
      channel: true,
      score: true,
      scoreReason: true,
      summary: true,
      website: true,
      searchCategory: true,
      searchLocation: true,
      contactedAt: true,
      repliedAt: true,
      convertedAt: true,
    },
  });
}

/** `leads-kairikos-2026-09-08.csv` — con la fecha dentro, para que el
 *  cliente que exporta cada lunes no acumule cinco `leads.csv` en Descargas
 *  sin saber cuál es cuál. */
export function exportFilename(now: Date = new Date()): string {
  return `leads-kairikos-${now.toISOString().slice(0, 10)}.csv`;
}
