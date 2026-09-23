import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderWebDraftHtml } from './web-draft-html';
import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// Producto Web, Fase 1 — convertir un ClientWebsite en los archivos que se
// suben a su alojamiento.
//
// Reutiliza la MISMA plantilla que el borrador (web-draft-html.ts) a
// propósito: lo que el prospecto vio por teléfono y lo que acaba publicado
// tienen que ser la misma página, o la venta se siente como un cambiazo. Lo
// que cambia es lo que se quita, no lo que se añade — ver stripDraftChrome.
//
// El sitio tiene que ser AUTÓNOMO. En el borrador la foto de portada la sirve
// el portal (/web-draft/beauty.jpg); una vez publicado en el servidor del
// cliente, ese enlace apuntaría a nosotros para siempre: su web se caería si
// cae nuestro VPS, y nos regalaría tráfico ajeno. Por eso la imagen se sube
// junto al HTML y la referencia se reescribe a una ruta relativa.
// =============================================================================

export interface WebsiteFile {
  /** Ruta relativa dentro del directorio remoto ('index.html',
   *  'assets/hero.jpg'). Nunca empieza por barra: se une al remotePath. */
  path: string;
  content: Buffer;
}

export interface WebsiteBuildInput {
  businessName: string;
  primaryType: string | null;
  themeKey: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  copy: WebDraftCopy;
  generatedAt: Date;
}

/**
 * Quita del HTML lo que solo tiene sentido mientras es una propuesta: la
 * banda de "Propuesta de Kairikos, todavía no publicado" y la coletilla del
 * precio en el pie.
 *
 * Se hace quitando y no con un parámetro más en la plantilla porque el
 * criterio es exactamente ese: el sitio publicado es el borrador MENOS la
 * parte comercial. Un flag invitaría a que las dos versiones se separaran.
 */
export function stripDraftChrome(html: string): string {
  return html
    .replace(/<div class="banner">[\s\S]*?<\/div><\/div>\n?/, '')
    .replace(/\s*Borrador generado por Kairikos[\s\S]*?<\/p>/, '</p>')
    .replace(/<p class="note">\s*<\/p>/, '');
}

/** La ruta de la foto de portada dentro del sitio publicado. */
export const HERO_ASSET_PATH = 'assets/portada.jpg';

export async function buildWebsiteFiles(input: WebsiteBuildInput): Promise<WebsiteFile[]> {
  const html = renderWebDraftHtml({
    subject: {
      businessName: input.businessName,
      primaryType: input.primaryType,
      city: input.city,
      address: input.address,
      phone: input.phone,
      // El sitio publicado no enseña las estrellas de Google: en el borrador
      // son la prueba de que la página es suya, pero en su web ya publicada
      // serían un dato que envejece solo y que nadie actualiza.
      rating: null,
      reviewCount: null,
    },
    copy: input.copy,
    themeKey: input.themeKey,
    generatedAt: input.generatedAt,
  });

  const family = input.themeKey.split('-')[0];
  const heroSource = path.join(process.cwd(), 'public', 'web-draft', `${family}.jpg`);
  const files: WebsiteFile[] = [];

  let heroBundled = false;
  try {
    const hero = await readFile(heroSource);
    files.push({ path: HERO_ASSET_PATH, content: hero });
    heroBundled = true;
  } catch {
    // Sin foto del sector, la plantilla ya cae al degradado generado (.svg).
    // Ese sí se puede dejar embebido por ruta absoluta… salvo que tampoco:
    // el sitio publicado no debe pedirle NADA al portal. Se sube el svg.
    try {
      const svg = await readFile(path.join(process.cwd(), 'public', 'web-draft', `${family}.svg`));
      files.push({ path: 'assets/portada.svg', content: svg });
    } catch {
      // Ni jpg ni svg: la portada queda con el color de fondo sólido. Feo,
      // pero publicable; nunca un enlace roto al portal.
    }
  }

  const localHtml = html
    .replace(new RegExp(`/web-draft/${family}\\.jpg`, 'g'), heroBundled ? HERO_ASSET_PATH : 'assets/portada.svg')
    .replace(new RegExp(`/web-draft/${family}\\.svg`, 'g'), 'assets/portada.svg');

  files.unshift({ path: 'index.html', content: Buffer.from(stripDraftChrome(localHtml), 'utf8') });
  return files;
}

/** Comprobación de que no queda ningún enlace al portal en lo que se publica.
 *  Exportada porque es una aserción de producto, no un detalle: una web de
 *  cliente que dependa de nuestro servidor es exactamente lo que este diseño
 *  quiere evitar. */
export function hasPortalReferences(html: string): boolean {
  return /\/web-draft\//.test(html) || /portal\.kairikos/.test(html);
}
