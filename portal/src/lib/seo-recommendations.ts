import type { SeoAuditResult } from './seo-audit';

// =============================================================================
// Fase 3.2 — la auditoría propone, no solo diagnostica.
//
// seo-audit.ts devuelve señales crudas: cuántas imágenes sin alt, si hay
// meta description, cuántos h1, qué enlaces están rotos. Útil para un
// operador que sepa de SEO; ilegible para el dueño de una peluquería, que
// es quien paga. Y hasta ahora ni siquiera se le enseñaba.
//
// Esto convierte cada señal en una frase accionable, con su porqué. No es
// un fichero de plantillas de texto: el orden y la severidad codifican qué
// mueve la aguja primero, que es justo lo que un cliente no sabe decidir.
//
// `autoApplicable` marca lo que el portal PODRÍA arreglar solo por la
// conexión de WordPress que ya existe. Marcarlo no es aplicarlo: escribir
// en la web viva de un cliente es una decisión suya, no un efecto
// secundario de una auditoría.
//
// Puro y sin I/O: se puede probar entero sin red ni base de datos.
// =============================================================================

export type RecommendationSeverity = 'alta' | 'media' | 'baja';

export interface SeoRecommendation {
  /** Estable, para poder marcarlas como hechas más adelante. */
  id: string;
  severity: RecommendationSeverity;
  /** Qué hay que hacer, en una línea. */
  title: string;
  /** Por qué importa, en lenguaje del cliente. */
  detail: string;
  /** Podría aplicarlo el portal por la conexión de WordPress. */
  autoApplicable: boolean;
}

const SEVERITY_ORDER: Record<RecommendationSeverity, number> = { alta: 0, media: 1, baja: 2 };

/** Un título por debajo de esto se queda corto en Google y desaprovecha
 *  espacio; por encima del máximo, Google lo corta. */
const TITLE_MIN = 30;
const TITLE_MAX = 60;
/** Rango habitual antes de que Google recorte la descripción. */
const META_MIN = 70;
const META_MAX = 155;

export function buildRecommendations(audit: SeoAuditResult): SeoRecommendation[] {
  const out: SeoRecommendation[] = [];

  // --- Título ---
  if (!audit.title || audit.title.trim().length === 0) {
    out.push({
      id: 'title-missing',
      severity: 'alta',
      title: 'Tu web no tiene título',
      detail:
        'El título es lo primero que se lee en Google, en azul y grande. Sin él, Google se inventa uno con lo que pilla de la página.',
      autoApplicable: true,
    });
  } else if (audit.title.length < TITLE_MIN) {
    out.push({
      id: 'title-short',
      severity: 'media',
      title: `Alarga el título: tiene ${audit.title.length} caracteres`,
      detail: `Entre ${TITLE_MIN} y ${TITLE_MAX} caracteres aprovechas todo el espacio que Google te da. Añade lo que haces y dónde.`,
      autoApplicable: true,
    });
  } else if (audit.title.length > TITLE_MAX) {
    out.push({
      id: 'title-long',
      severity: 'baja',
      title: `Acorta el título: tiene ${audit.title.length} caracteres`,
      detail: `Google corta alrededor de los ${TITLE_MAX}. Lo que sobra no se lee, así que pon lo importante al principio.`,
      autoApplicable: true,
    });
  }

  // --- Meta description ---
  if (!audit.metaDescription || audit.metaDescription.trim().length === 0) {
    out.push({
      id: 'meta-missing',
      severity: 'alta',
      title: 'Falta la descripción que aparece bajo el título en Google',
      detail:
        'Es el texto que decide si alguien hace clic en tu resultado o en el de al lado. Sin ella, Google recorta una frase suelta de tu web.',
      autoApplicable: true,
    });
  } else if (audit.metaDescription.length < META_MIN) {
    out.push({
      id: 'meta-short',
      severity: 'baja',
      title: 'La descripción se queda corta',
      detail: `Con ${META_MIN}-${META_MAX} caracteres puedes decir qué ofreces y por qué llamarte a ti. Ahora tiene ${audit.metaDescription.length}.`,
      autoApplicable: true,
    });
  }

  // --- Encabezados ---
  if (audit.h1Count === 0) {
    out.push({
      id: 'h1-missing',
      severity: 'alta',
      title: 'La página no tiene encabezado principal',
      detail:
        'El encabezado grande de la página le dice a Google de qué va. Sin él, tiene que adivinarlo por el resto del texto.',
      autoApplicable: false,
    });
  } else if (audit.h1Count > 1) {
    out.push({
      id: 'h1-multiple',
      severity: 'baja',
      title: `Hay ${audit.h1Count} encabezados principales; debería haber uno`,
      detail:
        'Con varios, ninguno destaca: es como subrayar la página entera. Deja uno como título y baja el resto a subtítulos.',
      autoApplicable: false,
    });
  }

  // --- Imágenes ---
  if (audit.imagesMissingAlt > 0) {
    const share = audit.imagesTotal > 0 ? Math.round((audit.imagesMissingAlt / audit.imagesTotal) * 100) : 100;
    out.push({
      id: 'images-alt',
      severity: share >= 50 ? 'media' : 'baja',
      title: `${audit.imagesMissingAlt} ${audit.imagesMissingAlt === 1 ? 'imagen' : 'imágenes'} sin descripción`,
      detail:
        'La descripción de una imagen es lo que leen Google y quien navega con lector de pantalla. También es la única forma de aparecer en la búsqueda de imágenes.',
      autoApplicable: true,
    });
  }

  // --- Enlaces rotos ---
  if (audit.brokenLinks.length > 0) {
    out.push({
      id: 'broken-links',
      severity: 'alta',
      title: `${audit.brokenLinks.length} ${audit.brokenLinks.length === 1 ? 'enlace roto' : 'enlaces rotos'}`,
      detail: `Llevan a una página que no existe: ${audit.brokenLinks
        .slice(0, 3)
        .map((l) => l.url)
        .join(', ')}${audit.brokenLinks.length > 3 ? '…' : ''}. Quien los pulsa se va, y Google lo interpreta como abandono.`,
      autoApplicable: false,
    });
  }

  // --- Enlaces internos ---
  if (audit.linksInternal === 0) {
    out.push({
      id: 'internal-links',
      severity: 'media',
      title: 'La página no enlaza a ninguna otra de tu web',
      detail:
        'Los enlaces entre tus propias páginas son los que hacen que Google recorra el resto del sitio. Sin ellos, esta página queda aislada.',
      autoApplicable: false,
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Cuántas hay de cada severidad — para el resumen de la tarjeta. */
export function countBySeverity(recommendations: SeoRecommendation[]): Record<RecommendationSeverity, number> {
  return recommendations.reduce(
    (acc, rec) => ({ ...acc, [rec.severity]: acc[rec.severity] + 1 }),
    { alta: 0, media: 0, baja: 0 } as Record<RecommendationSeverity, number>,
  );
}

/** Narrowing defensivo: `SeoProfile.lastAuditResult` es un Json libre, así
 *  que puede venir de una versión anterior del auditor o directamente
 *  corrupto. Devuelve null en vez de reventar la página del cliente. */
export function parseAuditResult(value: unknown): SeoAuditResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.h1Count !== 'number' || typeof raw.imagesMissingAlt !== 'number') return null;

  return {
    title: typeof raw.title === 'string' ? raw.title : null,
    metaDescription: typeof raw.metaDescription === 'string' ? raw.metaDescription : null,
    h1Count: raw.h1Count,
    h1Texts: Array.isArray(raw.h1Texts) ? raw.h1Texts.filter((t): t is string => typeof t === 'string') : [],
    imagesTotal: typeof raw.imagesTotal === 'number' ? raw.imagesTotal : 0,
    imagesMissingAlt: raw.imagesMissingAlt,
    linksInternal: typeof raw.linksInternal === 'number' ? raw.linksInternal : 0,
    linksExternal: typeof raw.linksExternal === 'number' ? raw.linksExternal : 0,
    brokenLinksChecked: typeof raw.brokenLinksChecked === 'number' ? raw.brokenLinksChecked : 0,
    brokenLinks: Array.isArray(raw.brokenLinks)
      ? raw.brokenLinks
          .filter((l): l is { url: string; status: number | null } =>
            Boolean(l) && typeof l === 'object' && typeof (l as { url?: unknown }).url === 'string',
          )
          .map((l) => ({ url: l.url, status: typeof l.status === 'number' ? l.status : null }))
      : [],
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : '',
  };
}
