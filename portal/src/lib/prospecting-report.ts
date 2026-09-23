// =============================================================================
// A1 · Informe de prospección con comparativa de competidores.
//
// Este archivo es TODO el cálculo del informe y no ve la base de datos, ni
// la red, ni un clientId: recibe números y devuelve números, igual que
// summarizeProspecting (prospecting-metrics.ts) y summarizeReviews
// (review-reputation.ts). Quien llama reúne el material y decide qué hacer
// con el resultado.
//
// Por qué existe: el informe es el gancho de la llamada comercial, y una
// cifra mal calculada delante de un negocio real cuesta la venta y la
// credibilidad. Aislarlo aquí permite probar los casos feos —sin
// competidores, sin reseñas, empates, valores absurdos— sin tocar Google.
//
// Regla que atraviesa el archivo: "no hay dato" NUNCA se convierte en 0.
// Un negocio recién abierto sin reseñas y un negocio cuyas reseñas no
// pedimos son ambos null aquí, y las dos cosas se descartan de las medias
// en vez de hundirlas. Un informe que dice "la media de tu zona es 1,2
// estrellas" porque contó nulls como ceros es peor que no enseñar nada.
// =============================================================================

export interface CompetitorInput {
  placeId: string;
  name: string;
  rating: number | null;
  reviewCount: number | null;
  /** Metros en línea recta desde el negocio del informe. Null si alguno
   *  de los dos no traía coordenadas. */
  distanceMeters: number | null;
}

export interface ComparisonSubject {
  name: string;
  rating: number | null;
  reviewCount: number | null;
}

export interface CompetitorComparison {
  /** Competidores que realmente entraron en el cálculo (los que tienen
   *  valoración). Cero significa "no se puede comparar", no "es el mejor". */
  comparedCount: number;
  averageRating: number | null;
  averageReviewCount: number | null;
  /** 1 = el mejor valorado de los comparados, incluido el propio negocio.
   *  Null cuando el negocio no tiene valoración o no hay con quién
   *  compararlo. */
  ratingRank: number | null;
  /** Cuántos entran en el ranking: el negocio más sus competidores
   *  válidos. "3º de 4" se arma con ratingRank y rankedCount. */
  rankedCount: number;
  /** Diferencia de estrellas contra la media de la zona. Positivo = va por
   *  delante. Redondeado a una décima, que es como se lee en Google. */
  ratingGap: number | null;
  /** Reseñas que le faltan para alcanzar al que más tiene. 0 = ya es el
   *  que más tiene. Null si falta el dato de un lado. */
  reviewGapToTop: number | null;
  /** Quién manda en la zona por número de reseñas — el nombre que hace que
   *  la conversación deje de ser abstracta. */
  reviewLeaderName: string | null;
  reviewLeaderCount: number | null;
}

/** Un competidor sin valoración no resta ni suma: se descarta. Ver la nota
 *  de cabecera sobre null contra 0. */
function hasRating(c: CompetitorInput): c is CompetitorInput & { rating: number } {
  return typeof c.rating === 'number' && Number.isFinite(c.rating);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function buildCompetitorComparison(
  subject: ComparisonSubject,
  competitors: CompetitorInput[],
): CompetitorComparison {
  const rated = competitors.filter(hasRating);
  const avgRating = average(rated.map((c) => c.rating));
  const reviewCounts = rated
    .map((c) => c.reviewCount)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const avgReviews = average(reviewCounts);

  const subjectRating =
    typeof subject.rating === 'number' && Number.isFinite(subject.rating) ? subject.rating : null;
  const subjectReviews =
    typeof subject.reviewCount === 'number' && Number.isFinite(subject.reviewCount)
      ? subject.reviewCount
      : null;

  // El ranking incluye al propio negocio: "eres el 3º de 4" se entiende
  // solo, "hay 3 mejores que tú" hay que traducirlo mentalmente.
  const rankedCount = subjectRating === null ? rated.length : rated.length + 1;
  // Empate = misma posición, no la peor: dos negocios a 4,5 son los dos
  // segundos. Se cuenta cuántos le superan ESTRICTAMENTE.
  const ratingRank =
    subjectRating === null || rated.length === 0
      ? null
      : rated.filter((c) => c.rating > subjectRating).length + 1;

  const leader = reviewCounts.length > 0 ? rated.reduce(pickReviewLeader) : null;
  const leaderCount =
    leader && typeof leader.reviewCount === 'number' && Number.isFinite(leader.reviewCount)
      ? leader.reviewCount
      : null;

  return {
    comparedCount: rated.length,
    averageRating: avgRating === null ? null : roundTo(avgRating, 1),
    averageReviewCount: avgReviews === null ? null : Math.round(avgReviews),
    ratingRank,
    rankedCount,
    ratingGap: subjectRating === null || avgRating === null ? null : roundTo(subjectRating - avgRating, 1),
    reviewGapToTop:
      subjectReviews === null || leaderCount === null ? null : Math.max(0, leaderCount - subjectReviews),
    reviewLeaderName: leaderCount === null ? null : (leader?.name ?? null),
    reviewLeaderCount: leaderCount,
  };
}

function pickReviewLeader(
  best: CompetitorInput & { rating: number },
  candidate: CompetitorInput & { rating: number },
): CompetitorInput & { rating: number } {
  const bestCount = typeof best.reviewCount === 'number' ? best.reviewCount : -1;
  const candidateCount = typeof candidate.reviewCount === 'number' ? candidate.reviewCount : -1;
  return candidateCount > bestCount ? candidate : best;
}

// -----------------------------------------------------------------------------
// Lo que pierde por no coger el teléfono
// -----------------------------------------------------------------------------

export interface MissedCallAssumptions {
  missedCallsPerWeek: number;
  averageJobValue: number;
  /** Proporción, no porcentaje: 0.3 = 30 %. */
  closeRate: number;
}

export interface MissedCallEstimate {
  monthlyLostRevenue: number;
  annualLostRevenue: number;
  /** Las tres cifras de las que sale el número, para imprimirlas al lado.
   *  El informe SIEMPRE enseña sus supuestos: una estimación que no se
   *  puede discutir no se puede defender delante del cliente, y la
   *  primera objeción real siempre es "yo no pierdo tantas llamadas". */
  assumptions: MissedCallAssumptions;
}

/** Valores por defecto deliberadamente conservadores: es mejor que el
 *  negocio conteste "pierdo más que eso" a tener que defender una cifra
 *  inflada. 3 llamadas perdidas a la semana es lo que reconoce cualquier
 *  autónomo de oficio en cuanto se le pregunta. */
export const DEFAULT_MISSED_CALL_ASSUMPTIONS: Readonly<MissedCallAssumptions> = Object.freeze({
  missedCallsPerWeek: 3,
  averageJobValue: 300,
  closeRate: 0.3,
});

const WEEKS_PER_MONTH = 52 / 12;

/** Saneado antes de multiplicar: estos tres números llegan de una query
 *  string que escribe el comercial en la llamada, y un informe con
 *  "pierdes 4.800.000 € al año" por un cero de más no se puede enseñar.
 *  Se recorta en silencio al rango defendible en vez de fallar: el
 *  informe tiene que salir igualmente. */
function sanitize(input: Partial<MissedCallAssumptions>): MissedCallAssumptions {
  const d = DEFAULT_MISSED_CALL_ASSUMPTIONS;
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(Math.max(n, min), max);
  };
  return {
    missedCallsPerWeek: clamp(input.missedCallsPerWeek, d.missedCallsPerWeek, 0, 100),
    averageJobValue: clamp(input.averageJobValue, d.averageJobValue, 0, 100000),
    closeRate: clamp(input.closeRate, d.closeRate, 0, 1),
  };
}

export function estimateMissedCallValue(input: Partial<MissedCallAssumptions> = {}): MissedCallEstimate {
  const assumptions = sanitize(input);
  const monthly =
    assumptions.missedCallsPerWeek * WEEKS_PER_MONTH * assumptions.averageJobValue * assumptions.closeRate;
  return {
    monthlyLostRevenue: Math.round(monthly),
    // Sobre el mensual redondeado a propósito: si el informe enseña las
    // dos cifras, que la anual sea exactamente doce veces la mensual.
    // Un cliente que multiplica y no le cuadra deja de creerse el resto.
    annualLostRevenue: Math.round(monthly) * 12,
    assumptions,
  };
}

// -----------------------------------------------------------------------------
// El modelo completo que consume la plantilla
// -----------------------------------------------------------------------------

export interface ReportSubjectInput extends ComparisonSubject {
  address: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  location: string | null;
}

export type ReportFinding = {
  kind: 'website_missing' | 'reviews_behind' | 'rating_behind' | 'no_reviews' | 'rating_ahead';
  /** Frase ya escrita, en el tono del informe. La plantilla no compone
   *  texto: aquí se decide qué se dice y con qué números. */
  text: string;
};

export interface ReportModel {
  subject: ReportSubjectInput;
  comparison: CompetitorComparison;
  competitors: CompetitorInput[];
  estimate: MissedCallEstimate;
  findings: ReportFinding[];
  capturedAt: Date;
}

export function buildReportModel(params: {
  subject: ReportSubjectInput;
  competitors: CompetitorInput[];
  assumptions?: Partial<MissedCallAssumptions>;
  capturedAt: Date;
}): ReportModel {
  const comparison = buildCompetitorComparison(params.subject, params.competitors);
  const estimate = estimateMissedCallValue(params.assumptions ?? {});
  return {
    subject: params.subject,
    comparison,
    competitors: params.competitors,
    estimate,
    findings: buildFindings(params.subject, comparison),
    capturedAt: params.capturedAt,
  };
}

/** Los hallazgos son lo que el comercial lee en voz alta, así que van en
 *  orden de fuerza y nunca se inventan: si falta el dato, no hay frase.
 *  Se incluye también el caso bueno (`rating_ahead`) a propósito — un
 *  informe que solo trae malas noticias suena a vendedor, y el negocio que
 *  va por delante de su zona es justo el que más fácil entiende que
 *  perder llamadas le cuesta dinero. */
function buildFindings(subject: ComparisonSubject, comparison: CompetitorComparison): ReportFinding[] {
  const findings: ReportFinding[] = [];

  if (subject.reviewCount === null || subject.reviewCount === 0) {
    findings.push({
      kind: 'no_reviews',
      text: 'No tiene reseñas en Google: hoy es invisible frente a quien sí las tiene.',
    });
  } else if (comparison.reviewGapToTop !== null && comparison.reviewGapToTop > 0) {
    const leader = comparison.reviewLeaderName ? ` (${comparison.reviewLeaderName})` : '';
    findings.push({
      kind: 'reviews_behind',
      text: `Le faltan ${comparison.reviewGapToTop} reseñas para alcanzar al primero de su zona${leader}.`,
    });
  }

  if (comparison.ratingGap !== null) {
    if (comparison.ratingGap < 0) {
      findings.push({
        kind: 'rating_behind',
        text: `Está ${Math.abs(comparison.ratingGap)} estrellas por debajo de la media de su zona.`,
      });
    } else if (comparison.ratingGap > 0) {
      findings.push({
        kind: 'rating_ahead',
        text: `Está ${comparison.ratingGap} estrellas por encima de la media de su zona: la reputación ya la tiene ganada.`,
      });
    }
  }

  return findings;
}

/** Distancia en línea recta, para ordenar competidores por cercanía. No se
 *  usa para nada que dependa de la precisión: a estas distancias la
 *  fórmula del semiverseno sobra y evita una dependencia nueva. */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_M = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}
