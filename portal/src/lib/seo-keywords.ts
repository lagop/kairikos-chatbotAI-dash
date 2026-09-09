import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 3.1 — palabras clave objetivo y seguimiento de posiciones.
//
// Lo primero que pide cualquier cliente de SEO —"¿estoy subiendo por lo que
// me importa?"— no existía a ningún precio: el portal medía lo que Google
// ya devolvía, pero nadie podía declarar por qué quería salir.
//
// El seguimiento necesita tabla propia porque SeoSearchConsoleQuery se
// borra y se reescribe entera en cada sincronización: es una foto, no una
// serie. Aquí se archiva un punto por palabra y día, solo de las palabras
// que el cliente persigue.
// =============================================================================

/** Cuántas palabras puede seguir un cliente. No es una limitación técnica:
 *  con más de esto la lista deja de ser una estrategia y pasa a ser un
 *  listado, y el panel deja de leerse de un vistazo. */
export const MAX_TARGET_KEYWORDS = 20;

/** Search Console devuelve las consultas en minúsculas y sin espacios
 *  sobrantes. Si no normalizáramos igual, "Mechas " y "mechas" serían dos
 *  objetivos distintos y ninguno casaría nunca con lo que llega. */
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Día UTC, sin hora: la unidad del histórico. */
export function toUtcDate(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface KeywordSnapshotRow {
  query: string;
  position: number;
  clicks: number;
  impressions: number;
}

export interface SnapshotResult {
  /** Palabras objetivo del cliente en el momento del barrido. */
  tracked: number;
  /** De ésas, las que hoy aparecen en Search Console. */
  ranking: number;
}

/**
 * Archiva la posición de hoy para cada palabra objetivo del cliente, a
 * partir de las consultas que acaba de traer la sincronización.
 *
 * Una palabra que hoy no aparece se guarda con `position: null`, no se
 * omite: "hoy no salgo por esto" es información, y dejar el hueco haría
 * que el gráfico uniera dos días distantes como si fueran consecutivos.
 *
 * Idempotente por (palabra, día): sincronizar dos veces el mismo día
 * actualiza el punto en vez de duplicarlo.
 */
export async function snapshotKeywordPositions(
  prisma: PrismaClient,
  clientId: string,
  rows: KeywordSnapshotRow[],
  now: Date = new Date(),
): Promise<SnapshotResult> {
  const targets = await prisma.seoTargetKeyword.findMany({
    where: { clientId },
    select: { id: true, keyword: true },
  });
  if (targets.length === 0) return { tracked: 0, ranking: 0 };

  const byQuery = new Map(rows.map((row) => [normalizeKeyword(row.query), row]));
  const date = toUtcDate(now);
  let ranking = 0;

  for (const target of targets) {
    const match = byQuery.get(target.keyword);
    if (match) ranking += 1;

    const data = {
      position: match ? match.position : null,
      clicks: match?.clicks ?? 0,
      impressions: match?.impressions ?? 0,
    };

    await prisma.seoKeywordPosition.upsert({
      where: { targetKeywordId_date: { targetKeywordId: target.id, date } },
      create: { targetKeywordId: target.id, date, ...data },
      update: data,
    });
  }

  return { tracked: targets.length, ranking };
}

export interface KeywordTrend {
  id: string;
  keyword: string;
  /** Última posición conocida, null si nunca ha aparecido. */
  position: number | null;
  /** Posición de referencia hace ~30 días, para la comparación. */
  previousPosition: number | null;
  /**
   * Cuánto ha mejorado, en puestos. Positivo = ha subido (la posición
   * numérica bajó). null cuando falta alguno de los dos extremos, que es
   * distinto de "no ha cambiado".
   */
  change: number | null;
  clicks: number;
  impressions: number;
  /** Serie para el gráfico, del punto más antiguo al más reciente. */
  history: { date: string; position: number | null }[];
}

/** Ventana del histórico que se muestra y contra la que se compara. */
export const KEYWORD_TREND_DAYS = 30;

export async function buildKeywordTrends(
  prisma: PrismaClient,
  clientId: string,
  now: Date = new Date(),
): Promise<KeywordTrend[]> {
  const since = new Date(now.getTime() - KEYWORD_TREND_DAYS * 24 * 60 * 60_000);

  const targets = await prisma.seoTargetKeyword.findMany({
    where: { clientId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      keyword: true,
      positions: {
        where: { date: { gte: toUtcDate(since) } },
        orderBy: { date: 'asc' },
        select: { date: true, position: true, clicks: true, impressions: true },
      },
    },
  });

  return targets.map((target) => {
    const points = target.positions;
    const ranked = points.filter((p) => p.position !== null);
    const latest = ranked.at(-1) ?? null;
    const earliest = ranked[0] ?? null;

    // Mejorar en SEO es BAJAR de número: de la 14 a la 8 son 6 puestos
    // ganados. Se invierte aquí, una vez, para que ninguna vista tenga que
    // acordarse de hacerlo.
    const change =
      latest?.position != null && earliest?.position != null && latest !== earliest
        ? Math.round((earliest.position - latest.position) * 10) / 10
        : null;

    return {
      id: target.id,
      keyword: target.keyword,
      position: latest?.position ?? null,
      previousPosition: earliest?.position ?? null,
      change,
      clicks: latest?.clicks ?? 0,
      impressions: latest?.impressions ?? 0,
      history: points.map((p) => ({ date: p.date.toISOString().slice(0, 10), position: p.position })),
    };
  });
}
