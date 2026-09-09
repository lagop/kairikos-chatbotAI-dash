import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 2.1 — el resumen de reputación que el cliente ve en /portal/resenas.
//
// El producto de reseñas sincronizaba, redactaba respuestas y publicaba,
// pero no le enseñaba al cliente ni un solo número que resumiera si estaba
// funcionando. Cuando llega la renovación, "¿ha mejorado mi reputación
// desde que os pago?" no tenía respuesta en el portal.
//
// No hace falta sincronizar nada nuevo: GoogleReview ya guarda starRating,
// createTime y si hay respuesta publicada. Esto es solo leer y agregar.
// =============================================================================

/** Meses que se muestran en la evolución. Un año entero es demasiado ancho
 *  para el panel y demasiado lento de leer; medio año deja ver la tendencia
 *  sin que las barras se conviertan en rayas. */
export const REPUTATION_MONTHS = 6;

export interface ReputationMonth {
  /** 'AAAA-MM', en UTC. */
  month: string;
  reviews: number;
  /** Media de estrellas del mes, null si no hubo reseñas. */
  average: number | null;
}

export interface ReputationSummary {
  totalReviews: number;
  /** Media histórica, null si todavía no hay ninguna reseña. */
  averageRating: number | null;
  /** Reseñas de los últimos 30 días. */
  reviewsLast30: number;
  /** Media de los últimos 90 días, para comparar con la histórica. */
  averageLast90: number | null;
  /** Reseñas con respuesta publicada, sobre el total. 0-1, null sin reseñas. */
  responseRate: number | null;
  /** Reseñas de 1 o 2 estrellas todavía sin responder. */
  unansweredNegative: number;
  /** Los últimos REPUTATION_MONTHS meses, del más antiguo al más reciente. */
  months: ReputationMonth[];
}

interface ReviewRow {
  starRating: number;
  createTime: Date;
  replyComment: string | null;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Redondeo a un decimal, que es como se lee una valoración de Google. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function averageOf(rows: ReviewRow[]): number | null {
  if (rows.length === 0) return null;
  return round1(rows.reduce((sum, r) => sum + r.starRating, 0) / rows.length);
}

/**
 * Puro: recibe las filas y devuelve el resumen. Separado de la consulta
 * para poder probar los bordes (sin reseñas, meses vacíos, cambio de año)
 * sin base de datos — mismo motivo por el que los parsers de IA de este
 * repo están aislados.
 */
export function summarizeReviews(rows: ReviewRow[], now: Date): ReputationSummary {
  const day = 24 * 60 * 60_000;
  const last30 = rows.filter((r) => now.getTime() - r.createTime.getTime() <= 30 * day);
  const last90 = rows.filter((r) => now.getTime() - r.createTime.getTime() <= 90 * day);

  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const key = monthKey(row.createTime);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(row);
    else byMonth.set(key, [row]);
  }

  // Los meses sin reseñas también aparecen: un hueco es información, y sin
  // ellos la evolución mentiría comprimiendo el tiempo.
  const months: ReputationMonth[] = [];
  for (let i = REPUTATION_MONTHS - 1; i >= 0; i -= 1) {
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(cursor);
    const bucket = byMonth.get(key) ?? [];
    months.push({ month: key, reviews: bucket.length, average: averageOf(bucket) });
  }

  const answered = rows.filter((r) => r.replyComment !== null && r.replyComment.trim().length > 0);

  return {
    totalReviews: rows.length,
    averageRating: averageOf(rows),
    reviewsLast30: last30.length,
    averageLast90: averageOf(last90),
    responseRate: rows.length === 0 ? null : answered.length / rows.length,
    unansweredNegative: rows.filter(
      (r) => r.starRating <= 2 && (r.replyComment === null || r.replyComment.trim().length === 0),
    ).length,
    months,
  };
}

export async function buildReputationSummary(
  prisma: PrismaClient,
  clientId: string,
  now: Date = new Date(),
): Promise<ReputationSummary> {
  const rows = await prisma.googleReview.findMany({
    where: { clientId },
    select: { starRating: true, createTime: true, replyComment: true },
  });
  return summarizeReviews(rows, now);
}
