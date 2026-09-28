import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { classifyWebsite } from './prospecting-report';

// =============================================================================
// A10 — estadísticas agregadas por sector y zona, cruzando TODOS los clientes.
//
// Para qué: el material del contenido con datos propios que pide el plan —
// "el 62 % de las peluquerías de Las Palmas no tiene web propia". Cada
// barrido de prospección deja cientos de negocios mirados uno a uno, y eso,
// agregado, es un estudio que nadie más tiene y que se publica gratis.
//
// Se diferencia de prospecting-metrics.ts en lo esencial: aquello mide LA
// CAMPAÑA de un cliente (cuántos encontró, cuántos contestaron). Esto mide EL
// MERCADO, sin cliente, y por eso es lo único del repo que agrega a través de
// tenants.
//
// Que agregue a través de clientes obliga a una regla: NUNCA sale un negocio
// concreto, solo recuentos. Ver MIN_GROUP_SIZE.
// =============================================================================

/** Por debajo de este tamaño, un grupo no se publica. Con tres negocios en
 *  una zona, "el 33 % no tiene web" es uno solo, y el que lo lea puede
 *  deducir cuál — además de que el porcentaje no significa nada. */
export const MIN_GROUP_SIZE = 10;

export interface SectorStatRow {
  sector: string;
  zona: string;
  negocios: number;
  conWebPropia: number;
  conFichaDeDirectorio: number;
  sinWeb: number;
  /** Solo de los que tienen valoración leída; nunca se cuenta un null como 0. */
  valoracionMedia: number | null;
  resenasMedianas: number | null;
}

export interface SectorStatsInput {
  searchCategory: string | null;
  searchLocation: string | null;
  contactName: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * Puro: agrega las filas por sector y zona. Aislado de la consulta para poder
 * probar los bordes —grupos pequeños, negocios sin valoración, webs de
 * directorio— sin base de datos.
 *
 * La mediana de reseñas y no la media a propósito: un negocio con 1.129
 * reseñas entre nueve con 20 desplaza la media hasta volverla inútil. La
 * mediana dice lo que de verdad tiene "uno normal" de ese sector.
 */
export function aggregateSectorStats(rows: SectorStatsInput[]): SectorStatRow[] {
  const groups = new Map<string, SectorStatsInput[]>();
  for (const row of rows) {
    const sector = row.searchCategory?.trim() || 'sin rubro';
    const zona = row.searchLocation?.trim() || 'sin zona';
    const key = `${sector}||${zona}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const result: SectorStatRow[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length < MIN_GROUP_SIZE) continue;
    const [sector, zona] = key.split('||');

    let conWebPropia = 0;
    let conFichaDeDirectorio = 0;
    let sinWeb = 0;
    for (const row of bucket) {
      const kind = classifyWebsite(row.website, row.contactName);
      if (kind === 'own') conWebPropia += 1;
      else if (kind === 'directory') conFichaDeDirectorio += 1;
      else sinWeb += 1;
    }

    const ratings = bucket.map((r) => r.rating).filter((v): v is number => typeof v === 'number');
    const reviews = bucket.map((r) => r.reviewCount).filter((v): v is number => typeof v === 'number');

    result.push({
      sector,
      zona,
      negocios: bucket.length,
      conWebPropia,
      conFichaDeDirectorio,
      sinWeb,
      valoracionMedia:
        ratings.length > 0 ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      resenasMedianas: median(reviews),
    });
  }

  // De más a menos negocios: los grupos grandes son los que dan titulares.
  return result.sort((a, b) => b.negocios - a.negocios);
}

export async function loadSectorStats(prisma: PrismaClient): Promise<SectorStatRow[]> {
  // Solo prospectos (outbound): un lead entrante no dice nada del mercado,
  // dice que alguien nos escribió.
  const rows = await prisma.lead.findMany({
    // NO se filtra por ChatbotClient.isInternal, y es a propósito: lo que
    // mide esto es EL MERCADO, no a quién pertenece la campaña. Un negocio
    // encontrado desde nuestra propia cuenta es un negocio de Google igual
    // que cualquier otro — tiene su web o no la tiene, y sus reseñas son las
    // que son. Filtrarlo por de quién era la búsqueda dejaría el estudio
    // vacío justo hoy, que las únicas campañas que existen son nuestras.
    //
    // Es la diferencia con business-metrics.ts, y conviene tenerla clara
    // antes de "arreglar" esto añadiendo el filtro: allí una cuenta nuestra
    // miente porque nadie paga, aquí no miente nada porque el dato no es
    // nuestro, es del negocio que se ha mirado.
    where: { source: 'outbound' },
    select: {
      searchCategory: true,
      searchLocation: true,
      contactName: true,
      website: true,
      competitorSnapshot: { select: { subjectRating: true, subjectReviewCount: true } },
    },
  });

  return aggregateSectorStats(
    rows.map((row) => ({
      searchCategory: row.searchCategory,
      searchLocation: row.searchLocation,
      contactName: row.contactName,
      website: row.website,
      rating: row.competitorSnapshot?.subjectRating ?? null,
      reviewCount: row.competitorSnapshot?.subjectReviewCount ?? null,
    })),
  );
}

/** CSV con el mismo escape anti-fórmula que lead-export.ts: una celda que
 *  empieza por '=' la ejecuta Excel al abrirla. */
function escapeCsv(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildSectorStatsCsv(rows: SectorStatRow[]): string {
  const header = [
    'Sector',
    'Zona',
    'Negocios',
    'Con web propia',
    'Con ficha de directorio',
    'Sin web',
    '% sin web propia',
    'Valoración media',
    'Reseñas medianas',
  ];
  const lines = rows.map((row) => {
    const sinWebPropia = Math.round(((row.conFichaDeDirectorio + row.sinWeb) / row.negocios) * 100);
    return [
      escapeCsv(row.sector),
      escapeCsv(row.zona),
      escapeCsv(row.negocios),
      escapeCsv(row.conWebPropia),
      escapeCsv(row.conFichaDeDirectorio),
      escapeCsv(row.sinWeb),
      escapeCsv(sinWebPropia),
      escapeCsv(row.valoracionMedia),
      escapeCsv(row.resenasMedianas),
    ].join(',');
  });
  return [header.map(escapeCsv).join(','), ...lines].join('\r\n');
}
