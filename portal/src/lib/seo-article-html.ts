import 'server-only';
import sanitizeHtml from 'sanitize-html';

// =============================================================================
// Revisión de seguridad del 22/09/2026 — HTML de los artículos SEO.
//
// El HTML que escribe la IA (o el que entra por el callback interno
// /api/internal/seo/content-drafts) iba a WordPress tal cual. Con la
// aprobación y la publicación automáticas —3 días de silencio del operador
// y otros tantos del cliente— un artículo puede salir sin que ninguna
// persona lo haya mirado, y la contraseña de aplicación suele ser de un
// administrador de WordPress, que tiene `unfiltered_html`: WordPress NO
// limpia lo que le mandamos. Un <script>, un <iframe> o un
// `onerror=` que colara una fuente manipulada (un competidor con una
// página que el rastreo lee, una consulta de Search Console inventada)
// acababa ejecutándose en la web del cliente, delante de sus visitantes.
//
// Se limpia en el único punto de salida (wordpress-publish.ts), no al
// generar: así también quedan cubiertos los borradores que ya existían y
// los que entran por el callback. Lista blanca, no lista negra: lo que un
// artículo de blog necesita y nada más.
//
// Fuera a propósito:
//   - <img>: el modelo no tiene imágenes propias que poner, así que una
//     <img> solo puede apuntar a un tercero (y avisarle de cada visita).
//   - style/class/id: la maquetación es del tema de WordPress.
//   - <h1>: el título del post ya es el encabezado principal (ver el
//     prompt en seo-content-ai.ts); se degrada a <h2>.
// =============================================================================

const ARTICLE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark',
    'blockquote', 'q', 'cite', 'abbr',
    'code', 'pre',
    'a',
    'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    abbr: ['title'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    h1: 'h2',
  },
  // Lo que no está en la lista se quita con su contenido cuando es
  // ejecutable o incrustado; el resto se desenvuelve y conserva el texto.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
};

/** Cuerpo del artículo, listo para `content` del post de WordPress. */
export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, ARTICLE_OPTIONS);
}

/**
 * Título y extracto: texto plano. Los temas de WordPress imprimen el
 * título sin escapar, así que ahí tampoco puede viajar ninguna etiqueta.
 */
export function toPlainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
}
