import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isGooglePlacesConfigured, searchPlaces, getPlaceRating, type PlaceSearchResult } from './google-places';
import { logError } from './observability';
import {
  buildCompetitorComparison,
  haversineMeters,
  type CompetitorInput,
  type ComparisonSubject,
} from './prospecting-report';

// =============================================================================
// A1 — captura de la zona de un prospecto: una búsqueda a Google y una fila
// guardada. Todo el cálculo vive en prospecting-report.ts (puro); aquí solo
// está lo que toca la red y la base de datos.
//
// Tres decisiones de coste, que son la razón de que este archivo exista
// separado del informe:
//
// 1. UNA sola búsqueda por informe, y trae al prospecto Y a sus
//    competidores. La búsqueda con estrellas es SKU Pro (más cara que la
//    del barrido semanal, más barata que pedir las estrellas en Place
//    Details, que es Enterprise + Atmosphere y se pagaría por cada lead).
// 2. Bajo demanda, no en el barrido semanal: de los cientos de prospectos
//    que encuentra una campaña, solo se llama a unos pocos, y solo esos
//    necesitan informe.
// 3. Caché de 30 días por lead. Las estrellas de un negocio no se mueven en
//    un mes lo bastante como para pagar otra búsqueda, y volver a abrir un
//    informe que ya se enseñó en una llamada debe dar lo mismo que se dijo.
// =============================================================================

export const SNAPSHOT_TTL_DAYS = 30;

/** Tres competidores, no cinco. Es lo que cabe en una frase dicha por
 *  teléfono ("te sacan X e Y") y lo que cabe en una página sin que el
 *  prospecto tenga que estudiarla. */
export const MAX_COMPETITORS = 3;

export interface CompetitorSnapshotSubject {
  leadId: string;
  clientId: string;
  tenantId: string | null;
  placeId: string | null;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Categoría de Google ('plumber'); si falta, se usa searchCategory. */
  primaryType: string | null;
  searchCategory: string | null;
  searchLocation: string | null;
}

export interface CompetitorSnapshotData {
  subjectRating: number | null;
  subjectReviewCount: number | null;
  competitors: CompetitorInput[];
  capturedAt: Date;
  /** true = se sirvió de la caché, sin llamar a Google ni gastar. */
  fromCache: boolean;
}

export type CaptureResult =
  | { ok: true; data: CompetitorSnapshotData }
  | { ok: false; error: 'not_configured' | 'subject_not_searchable' | 'search_failed' };

function isFresh(capturedAt: Date, now: Date): boolean {
  const elapsedDays = (now.getTime() - capturedAt.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays < SNAPSHOT_TTL_DAYS;
}

/** La consulta que se le manda a Google. Con `primaryType` de Google se
 *  busca "otros como este" de verdad; sin él se cae a lo que escribió el
 *  cliente en su campaña, que es más ruidoso pero mejor que nada. El tipo
 *  de Google viene en inglés y con guiones bajos ('hair_salon'), así que se
 *  pasa a palabras: Text Search entiende texto libre, no enums. */
export function buildCompetitorQuery(subject: CompetitorSnapshotSubject): string | null {
  const category = subject.primaryType
    ? subject.primaryType.replace(/_/g, ' ')
    : (subject.searchCategory ?? null);
  if (!category) return null;
  return subject.searchLocation ? `${category} en ${subject.searchLocation}` : category;
}

/** Filtra, ordena y recorta lo que devolvió Google. Exportada y pura para
 *  poder probar el caso feo de verdad: que el propio prospecto venga en sus
 *  propios resultados (pasa siempre) y no se cuente como competidor de sí
 *  mismo, lo que le regalaría un empate perfecto en todas las medias. */
export function selectCompetitors(
  results: PlaceSearchResult[],
  subject: CompetitorSnapshotSubject,
  limit: number = MAX_COMPETITORS,
): CompetitorInput[] {
  const origin =
    typeof subject.latitude === 'number' && typeof subject.longitude === 'number'
      ? { latitude: subject.latitude, longitude: subject.longitude }
      : null;

  const rows = results
    .filter((r) => r.id !== subject.placeId)
    // Sin valoración no aporta nada a una comparativa de reputación, y
    // dejarlo dentro solo gastaría una de las tres plazas.
    .filter((r) => typeof r.rating === 'number')
    .map((r) => ({
      placeId: r.id,
      name: r.name,
      rating: r.rating,
      reviewCount: r.userRatingCount,
      distanceMeters:
        origin && typeof r.latitude === 'number' && typeof r.longitude === 'number'
          ? haversineMeters(origin, { latitude: r.latitude, longitude: r.longitude })
          : null,
    }));

  // Por cercanía cuando hay coordenadas; si no, por número de reseñas, que
  // es la otra forma de que salgan los que el prospecto reconoce. Nunca se
  // ordena por estrellas: eso elegiría solo a los mejores y haría que todo
  // informe dijera "vas el último", que es exactamente la cifra inflada
  // que este informe no debe enseñar.
  rows.sort((a, b) => {
    if (a.distanceMeters !== null && b.distanceMeters !== null) return a.distanceMeters - b.distanceMeters;
    if (a.distanceMeters !== null) return -1;
    if (b.distanceMeters !== null) return 1;
    return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  });

  return rows.slice(0, limit);
}

/**
 * Las estrellas del propio prospecto.
 *
 * Primero se buscan entre los resultados que ya trajo la búsqueda de
 * competidores, que es gratis. Pero Google NO siempre devuelve al propio
 * negocio entre ellos — confirmado el 23/09/2026 contra una peluquería real
 * de Las Palmas: sus 3 competidores llegaron con estrellas y ella no salía.
 * El informe entonces afirmaba "no tiene reseñas en Google" a un negocio que
 * sí las tiene.
 *
 * Por eso, cuando no aparece, se le pregunta a Google por su place id. Esa
 * segunda llamada es Enterprise + Atmosphere (el SKU caro), y se paga como
 * mucho UNA vez por informe, nunca por lead del barrido. Es el precio de no
 * mentirle al negocio que intentas convencer.
 */
async function resolveSubjectRating(
  results: PlaceSearchResult[],
  subject: CompetitorSnapshotSubject,
): Promise<{ rating: number | null; reviewCount: number | null }> {
  const match =
    (subject.placeId ? results.find((r) => r.id === subject.placeId) : undefined) ??
    (subject.name ? results.find((r) => r.name === subject.name) : undefined);
  if (match && typeof match.rating === 'number') {
    return { rating: match.rating, reviewCount: match.userRatingCount };
  }

  if (!subject.placeId) return { rating: null, reviewCount: null };

  const details = await getPlaceRating(subject.placeId);
  if (!details.ok) {
    // Sin dato, el informe se calla: no afirma "no tiene reseñas".
    logError('prospecting.subject_rating_failed', new Error(details.error), { leadId: subject.leadId }, 'warn');
    return { rating: null, reviewCount: null };
  }
  return { rating: details.data.rating, reviewCount: details.data.userRatingCount };
}

/**
 * Devuelve la foto de la zona de este prospecto, de la caché si está
 * fresca y de Google si no. Seguro de llamar más veces de las necesarias:
 * dentro de la ventana de 30 días no gasta ni una llamada.
 *
 * `force` salta la caché — es para el operador que acaba de ver que el
 * prospecto tiene reseñas nuevas, no para el uso normal.
 */
export async function captureCompetitorSnapshot(
  prisma: PrismaClient,
  subject: CompetitorSnapshotSubject,
  options: { now?: Date; force?: boolean } = {},
): Promise<CaptureResult> {
  const now = options.now ?? new Date();

  const cached = await prisma.prospectingCompetitorSnapshot.findUnique({
    where: { leadId: subject.leadId },
  });
  if (cached && !options.force && isFresh(cached.capturedAt, now)) {
    return {
      ok: true,
      data: {
        subjectRating: cached.subjectRating,
        subjectReviewCount: cached.subjectReviewCount,
        competitors: cached.competitors as unknown as CompetitorInput[],
        capturedAt: cached.capturedAt,
        fromCache: true,
      },
    };
  }

  if (!(await isGooglePlacesConfigured())) {
    return { ok: false, error: 'not_configured' };
  }

  const textQuery = buildCompetitorQuery(subject);
  if (!textQuery) {
    // Ni categoría de Google ni rubro del cliente: no hay forma de saber
    // "otros como este". No es un error del sistema, es un lead al que no
    // se le puede hacer este informe.
    return { ok: false, error: 'subject_not_searchable' };
  }

  const search = await searchPlaces({
    textQuery,
    includeRatings: true,
    // El sesgo por coordenadas es lo que convierte "fontaneros en Elche" en
    // "fontaneros al lado de este negocio". Sin coordenadas, la búsqueda
    // por zona sigue valiendo, solo que los competidores serán de la zona y
    // no necesariamente los de su misma calle.
    locationBias:
      typeof subject.latitude === 'number' && typeof subject.longitude === 'number'
        ? { latitude: subject.latitude, longitude: subject.longitude, radiusMeters: 5000 }
        : undefined,
  });
  if (!search.ok) {
    logError('prospecting.competitor_search_failed', new Error(search.error), { leadId: subject.leadId }, 'warn');
    return { ok: false, error: 'search_failed' };
  }

  const competitors = selectCompetitors(search.data.results, subject);
  const subjectRating = await resolveSubjectRating(search.data.results, subject);
  const comparison = buildCompetitorComparison(
    { name: subject.name ?? '', rating: subjectRating.rating, reviewCount: subjectRating.reviewCount },
    competitors,
  );

  const payload = {
    clientId: subject.clientId,
    tenantId: subject.tenantId,
    subjectRating: subjectRating.rating,
    subjectReviewCount: subjectRating.reviewCount,
    competitors: competitors as unknown as object,
    // La comparativa se guarda ya calculada, no solo los ingredientes: es
    // lo que permite reabrir el informe exactamente como se enseñó aunque
    // mañana cambien las reglas de cálculo.
    metrics: comparison as unknown as object,
    capturedAt: now,
  };

  try {
    await prisma.prospectingCompetitorSnapshot.upsert({
      where: { leadId: subject.leadId },
      create: { leadId: subject.leadId, ...payload },
      update: payload,
    });
  } catch (err) {
    // La búsqueda ya está pagada: que no se pueda guardar no debe impedir
    // que el comercial vea el informe que acaba de pedir. Se devuelve el
    // resultado igual, sin caché.
    logError('prospecting.competitor_snapshot_persist_failed', err, { leadId: subject.leadId }, 'warn');
  }

  return {
    ok: true,
    data: {
      subjectRating: subjectRating.rating,
      subjectReviewCount: subjectRating.reviewCount,
      competitors,
      capturedAt: now,
      fromCache: false,
    },
  };
}

export type { ComparisonSubject };
