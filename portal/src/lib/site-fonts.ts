import { SITE_FONT_CATALOG } from './site-fonts-catalog';

// =============================================================================
// Webs con IA (27/10/2026) — las tipografías se sirven desde la propia web,
// no desde Google.
//
// Con el <link> a fonts.googleapis.com, el navegador de cada visitante de la
// web del cliente le pasa su IP a Google; había que declararlo en la política
// de privacidad, y en Alemania se ha sancionado. Ahora:
//
// - Las familias del catálogo están descargadas una vez en public/fuentes/
//   (scripts/descargar-tipografias.mjs), con un fuentes.css por familia cuyas
//   rutas son relativas a él mismo.
// - La plantilla sigue DECLARANDO sus tipografías con el <link> de Google
//   Fonts de siempre: es lo que el modelo sabe escribir sin pensar, y así el
//   validador lo puede leer. El motor lo cambia al pintar por un <link> a
//   fuentes/<familia>/fuentes.css.
// - La web publicada lleva su copia de esos archivos (website-build.ts); el
//   borrador y las vistas del portal usan los de /fuentes/ del propio portal.
//
// Una familia fuera del catálogo no se sirve: la página cae a la tipografía
// de respaldo de su CSS. Nunca se deja el enlace a Google como «mal menor»;
// el validador no deja aprobar una plantilla así, así que no debería pasar.
// =============================================================================

const GOOGLE_CSS_LINK = /<link\b[^>]*?\bhref\s*=\s*["'](https:\/\/fonts\.googleapis\.com\/css2?\?[^"']*)["'][^>]*>\s*/gi;
const GOOGLE_HINT_LINK = /<link\b[^>]*?\bhref\s*=\s*["']https:\/\/fonts\.(?:googleapis|gstatic)\.com\/?["'][^>]*>\s*/gi;
const GOOGLE_IMPORT = /@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/gi;

/** Las familias que pide un enlace de Google Fonts
 *  (css2?family=Fraunces:wght@600&family=Inter → Fraunces, Inter). */
export function googleFontFamilies(href: string): string[] {
  try {
    const url = new URL(href.replace(/&amp;/g, '&'));
    // css2 repite family=; la API vieja (css) las separa con «|».
    return url.searchParams
      .getAll('family')
      .flatMap((f) => f.split('|'))
      .map((f) => f.split(':')[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Las familias que declara un HTML con enlaces de Google Fonts, separadas
 *  en las que tenemos y las que no. */
export function declaredFontFamilies(html: string): { known: string[]; unknown: string[] } {
  const all = [...new Set([...html.matchAll(GOOGLE_CSS_LINK)].flatMap((m) => googleFontFamilies(m[1])))];
  return { known: all.filter((f) => f in SITE_FONT_CATALOG), unknown: all.filter((f) => !(f in SITE_FONT_CATALOG)) };
}

/** Los <link> a las hojas de las familias, servidas desde `base`
 *  ('' o '../' en la web publicada, '/' en el portal). */
export function fontStylesheetLinks(families: string[], base: string): string {
  return families
    .filter((f) => f in SITE_FONT_CATALOG)
    .map((f) => `<link rel="stylesheet" href="${base}fuentes/${SITE_FONT_CATALOG[f].slug}/fuentes.css">`)
    .join('\n');
}

/** Cambia los enlaces de Google Fonts de una página por los de la propia
 *  web, y quita los preconnect a Google, que solo sirven para ir a buscarlas. */
export function localizeGoogleFonts(html: string, base: string): string {
  return html
    .replace(GOOGLE_CSS_LINK, (_m, href: string) => {
      const links = fontStylesheetLinks(googleFontFamilies(href), base);
      return links ? `${links}\n` : '';
    })
    .replace(GOOGLE_HINT_LINK, '')
    .replace(GOOGLE_IMPORT, '');
}

/** Las hojas de tipografías que enlaza una página ya pintada, como slugs.
 *  Es lo que website-build.ts mira para saber qué archivos subir. */
export function linkedFontSlugs(html: string): string[] {
  return [...new Set([...html.matchAll(/href="(?:\.\.\/)*\/?fuentes\/([a-z0-9-]+)\/fuentes\.css"/g)].map((m) => m[1]))];
}

export function fontBySlug(slug: string): { family: string; files: readonly string[] } | null {
  const entry = Object.entries(SITE_FONT_CATALOG).find(([, f]) => f.slug === slug);
  return entry ? { family: entry[0], files: entry[1].files } : null;
}

/** El catálogo como texto para el encargo a la IA. */
export function fontCatalogForPrompt(): string {
  const by = (uso: 'display' | 'texto') =>
    Object.entries(SITE_FONT_CATALOG)
      .filter(([, f]) => f.uso === uso)
      .map(([name]) => name)
      .join(', ');
  return `para titulares: ${by('display')}; para el texto: ${by('texto')}`;
}
