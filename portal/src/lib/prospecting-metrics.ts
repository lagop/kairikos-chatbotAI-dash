import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { MAX_SEQUENCE_TOUCHES } from './prospecting-contact';

// =============================================================================
// Fase 3.4 — las métricas de campaña de Prospección con IA.
//
// El producto vende un cupo mensual de prospectos. Sin estas cifras el
// cliente no tiene forma de saber si ese cupo le está sirviendo para algo,
// ni de decidir dónde insistir — y nosotros no tenemos forma de demostrar
// que vale lo que cuesta. Es un agregado sobre Lead con source 'outbound';
// no hay tabla de métricas ni job que las precalcule.
//
// La regla que gobierna todo este archivo: **una tasa sin denominador es
// null, nunca 0**. "0% de respuesta" y "todavía no has contactado a nadie"
// se leen igualísimo en un panel y significan cosas opuestas; la primera
// hace que el cliente cancele.
//
// El desglose se apoya en Lead.searchCategory/searchLocation, no en la
// campaña: la campaña solo conoce su rubro y zona de HOY, así que agrupar
// por ella haría que todo el histórico pareciera venir de la última
// búsqueda configurada. Los leads anteriores a Fase 3.4 los tienen a null
// y caen en un grupo aparte, dicho como tal.
// =============================================================================

/** Un cliente que lleva un año cambiando de zona acumula demasiadas filas
 *  para una tarjeta. Se enseñan las de más volumen, que son las que
 *  soportan una decisión; el resto se resume en una línea. */
export const MAX_BREAKDOWN_ROWS = 6;

export const UNATTRIBUTED_LABEL = 'Sin registrar';

export interface ProspectingLeadRow {
  status: string;
  contactedAt: Date | null;
  repliedAt: Date | null;
  followUpCount: number;
  searchCategory: string | null;
  searchLocation: string | null;
}

export interface ProspectingBreakdownRow {
  label: string;
  found: number;
  contacted: number;
  replied: number;
  converted: number;
  /** replied / contacted, o null si no se ha contactado a nadie del grupo. */
  responseRate: number | null;
}

export interface ProspectingBreakdown {
  rows: ProspectingBreakdownRow[];
  /** Grupos que no caben en MAX_BREAKDOWN_ROWS, para poder decir cuántos
   *  quedan fuera en vez de esconderlos. */
  hiddenGroups: number;
}

export interface ProspectingMetrics {
  found: number;
  contacted: number;
  replied: number;
  converted: number;
  discarded: number;
  responseRate: number | null;
  conversionRate: number | null;
  /** Contactados, sin respuesta, y con la secuencia ya agotada: no van a
   *  recibir nada más. Es el número que dice cuánto del cupo se ha gastado
   *  sin resultado, y el que justifica cambiar de rubro o de zona. */
  sequenceExhausted: number;
  byCategory: ProspectingBreakdown;
  byLocation: ProspectingBreakdown;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function buildBreakdown(
  rows: ProspectingLeadRow[],
  pick: (row: ProspectingLeadRow) => string | null,
): ProspectingBreakdown {
  const groups = new Map<string, ProspectingBreakdownRow>();

  for (const row of rows) {
    const raw = pick(row)?.trim();
    const label = raw && raw.length > 0 ? raw : UNATTRIBUTED_LABEL;
    const group = groups.get(label) ?? { label, found: 0, contacted: 0, replied: 0, converted: 0, responseRate: null };
    group.found += 1;
    if (row.contactedAt !== null) group.contacted += 1;
    if (row.repliedAt !== null) group.replied += 1;
    if (row.status === 'convertido') group.converted += 1;
    groups.set(label, group);
  }

  const all = Array.from(groups.values())
    .map((g) => ({ ...g, responseRate: rate(g.replied, g.contacted) }))
    // Por volumen: el grupo con más prospectos es sobre el que el cliente
    // tiene más evidencia, y por tanto el que mejor soporta una decisión.
    .sort((a, b) => b.found - a.found || a.label.localeCompare(b.label, 'es'));

  return {
    rows: all.slice(0, MAX_BREAKDOWN_ROWS),
    hiddenGroups: Math.max(0, all.length - MAX_BREAKDOWN_ROWS),
  };
}

/**
 * Puro: mismas filas dentro, mismas cifras fuera. Toda la aritmética del
 * producto vive aquí para poder fijarla en tests sin base de datos —
 * mismo patrón que summarizeReviews en review-reputation.ts.
 */
export function summarizeProspecting(rows: ProspectingLeadRow[]): ProspectingMetrics {
  const contacted = rows.filter((r) => r.contactedAt !== null);
  const replied = rows.filter((r) => r.repliedAt !== null);
  const converted = rows.filter((r) => r.status === 'convertido');
  const discarded = rows.filter((r) => r.status === 'descartado');

  const sequenceExhausted = rows.filter(
    (r) => r.contactedAt !== null && r.repliedAt === null && r.followUpCount >= MAX_SEQUENCE_TOUCHES,
  ).length;

  return {
    found: rows.length,
    contacted: contacted.length,
    replied: replied.length,
    converted: converted.length,
    discarded: discarded.length,
    // Los dos denominadores son "contactados", no "encontrados": un
    // prospecto al que todavía no se ha escrito no ha tenido ocasión de
    // responder, y meterlo abajo hunde la tasa por algo que no ha pasado.
    responseRate: rate(replied.length, contacted.length),
    conversionRate: rate(converted.length, contacted.length),
    sequenceExhausted,
    byCategory: buildBreakdown(rows, (r) => r.searchCategory),
    byLocation: buildBreakdown(rows, (r) => r.searchLocation),
  };
}

/**
 * Todos los prospectos outbound del cliente, sin ventana temporal: la
 * pregunta que contesta esta tarjeta ("¿en qué zona me funciona?") se
 * responde con el histórico entero, no con el mes en curso. El cupo
 * mensual ya está en la tarjeta de perfil.
 */
export async function loadProspectingMetrics(
  prisma: PrismaClient,
  clientId: string,
): Promise<ProspectingMetrics> {
  const rows = await prisma.lead.findMany({
    where: { clientId, source: 'outbound' },
    select: {
      status: true,
      contactedAt: true,
      repliedAt: true,
      followUpCount: true,
      searchCategory: true,
      searchLocation: true,
    },
  });
  return summarizeProspecting(rows);
}
