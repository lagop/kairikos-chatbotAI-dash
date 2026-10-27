import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderWebDraftHtml } from './web-draft-html';
import type { WebDraftCopy } from './web-draft-ai';
import type { SiteContent } from './site-content';
import { renderSiteFiles, type SiteTemplateSource } from './site-template';
import { fontBySlug, linkedFontSlugs } from './site-fonts';

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
  /** El testigo del formulario. Con él, la página publicada lleva su
   *  formulario de contacto apuntando a nuestro buzón. */
  formToken?: string | null;
  /** Origen del portal, para componer la URL del buzón. Sale de la petición
   *  o de NEXT_PUBLIC_PORTAL_URL: nunca se codifica a mano aquí, porque un
   *  dominio equivocado deja el formulario mudo sin que nadie se entere. */
  portalOrigin?: string | null;
  businessName: string;
  primaryType: string | null;
  themeKey: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  copy: WebDraftCopy;
  generatedAt: Date;
  /** Lo que aporten otros productos contratados: estrellas de reviews y
   *  número de recall. Ver website-integrations.ts. */
  integrations?: { reviews: { rating: number; count: number } | null; recallPhone: string | null } | null;
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
    // 26/10/2026 — lo marcado como solo-borrador en la plantilla: «imagen de
    // muestra», «servicios orientativos». En su web publicada ya no lo son.
    .replace(/<!--draft-only-->[\s\S]*?<!--\/draft-only-->/g, '')
    .replace(/<div class="banner">[\s\S]*?<\/div><\/div>\n?/, '')
    .replace(/\s*Borrador generado por Kairikos[\s\S]*?<\/p>/, '</p>')
    .replace(/<p class="note">\s*<\/p>/, '');
}

/** La ruta de la foto de portada dentro del sitio publicado. */
export const HERO_ASSET_PATH = 'assets/portada.jpg';

export async function buildWebsiteFiles(input: WebsiteBuildInput): Promise<WebsiteFile[]> {
  const formAction =
    input.formToken && input.portalOrigin
      ? `${input.portalOrigin.replace(/\/+$/, '')}/api/public/website-form/${input.formToken}`
      : null;

  const html = renderWebDraftHtml({
    subject: {
      businessName: input.businessName,
      primaryType: input.primaryType,
      city: input.city,
      address: input.address,
      // Con recall contratado, el teléfono de la web es SU número de recall.
      // Si no, el suyo de siempre. Dejar el viejo haría que el producto que
      // acaba de comprar no recogiera ninguna llamada de su propia web, y es
      // un fallo que no da ningún error.
      phone: input.integrations?.recallPhone ?? input.phone,
      // Las estrellas solo si paga por reviews: son suyas y las enseña quien
      // cuida su reputación. Sin ese producto, la web no las muestra —
      // envejecerían solas y nadie las actualizaría.
      rating: input.integrations?.reviews?.rating ?? null,
      reviewCount: input.integrations?.reviews?.count ?? null,
    },
    copy: input.copy,
    themeKey: input.themeKey,
    generatedAt: input.generatedAt,
    formAction,
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
    .replace(new RegExp(`/web-draft/${family}\\.svg`, 'g'), 'assets/portada.svg')
    // Las tipografías, igual que la foto: viajan con la web (site-fonts.ts).
    .replace(/href="\/fuentes\//g, 'href="fuentes/');

  files.unshift({ path: 'index.html', content: Buffer.from(stripDraftChrome(localHtml), 'utf8') });
  return [...files, ...(await fontFiles([localHtml]))];
}

/**
 * Los archivos de las tipografías que enlazan las páginas, para subirlos con
 * ellas (fuentes/<familia>/fuentes.css y sus .woff2). Se mira el HTML ya
 * pintado y no la plantilla: lo que se sube es exactamente lo que se enlaza.
 * Un archivo que faltara en public/ se salta: la página cae a la tipografía
 * de respaldo, que es feo pero no rompe nada, y nunca se enlaza a Google.
 */
async function fontFiles(pages: string[]): Promise<WebsiteFile[]> {
  const files: WebsiteFile[] = [];
  for (const slug of new Set(pages.flatMap(linkedFontSlugs))) {
    const font = fontBySlug(slug);
    if (!font) continue;
    for (const name of ['fuentes.css', ...font.files]) {
      try {
        files.push({ path: `fuentes/${slug}/${name}`, content: await readFile(path.join(process.cwd(), 'public', 'fuentes', slug, name)) });
      } catch {
        // Ver arriba: sin el archivo, tipografía de respaldo.
      }
    }
  }
  return files;
}

/** La foto de portada del sector, para subirla junto al HTML. Mismo criterio
 *  que buildWebsiteFiles: el sitio publicado no le pide nada al portal. */
async function sectorHeroFile(themeKey: string): Promise<WebsiteFile | null> {
  const family = themeKey.split('-')[0];
  for (const [ext, dest] of [['jpg', HERO_ASSET_PATH], ['svg', 'assets/portada.svg']] as const) {
    try {
      return { path: dest, content: await readFile(path.join(process.cwd(), 'public', 'web-draft', `${family}.${ext}`)) };
    } catch {
      // Sin foto del sector se prueba la siguiente; sin ninguna, la plantilla
      // no pinta la figura (fotos.portada vacío).
    }
  }
  return null;
}

export interface DesignedWebsiteBuildInput {
  template: SiteTemplateSource;
  content: SiteContent;
  formToken?: string | null;
  portalOrigin?: string | null;
  businessName: string;
  themeKey: string;
  phone: string | null;
  address: string | null;
  integrations?: WebsiteBuildInput['integrations'];
  now: Date;
}

/**
 * Webs con IA, entrega 1 (27/10/2026) — los archivos de una web con
 * plantilla de diseño y contenido v2 (site-template.ts). Una página por
 * archivo ('index.html', 'servicios/index.html'…) más la foto de portada.
 *
 * Las mismas reglas que buildWebsiteFiles para lo que viene de otros
 * productos: con recall, el teléfono es su número de recall; con reviews,
 * las estrellas. Sin reviews no hay valoración: envejecería sola.
 */
export async function buildDesignedWebsiteFiles(input: DesignedWebsiteBuildInput): Promise<WebsiteFile[]> {
  const formAction =
    input.formToken && input.portalOrigin
      ? `${input.portalOrigin.replace(/\/+$/, '')}/api/public/website-form/${input.formToken}`
      : null;
  const hero = await sectorHeroFile(input.themeKey);
  const reviews = input.integrations?.reviews ?? null;
  const pages = renderSiteFiles(input.template, input.content, {
    negocio: {
      nombre: input.businessName,
      telefono: input.integrations?.recallPhone ?? input.phone,
      direccion: input.address,
      mapsUrl: input.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${input.businessName}, ${input.address}`)}` : null,
      valoracion: reviews ? reviews.rating.toFixed(1).replace('.', ',') : null,
      numResenas: reviews && reviews.count > 0 ? String(reviews.count) : null,
    },
    fotos: { portada: hero?.path ?? null, equipo: null, trabajo: null },
    formAction,
    borrador: false,
    // Entrega 4: aviso legal, privacidad y cookies en toda web publicada.
    legales: true,
    now: input.now,
  });
  const fonts = await fontFiles(pages.map((p) => p.content.toString('utf8')));
  return [...pages, ...(hero ? [hero] : []), ...fonts];
}

/** Comprobación de que no queda ningún enlace al portal en lo que se publica.
 *  Exportada porque es una aserción de producto, no un detalle: una web de
 *  cliente que dependa de nuestro servidor es exactamente lo que este diseño
 *  quiere evitar. */
export function hasPortalReferences(html: string): boolean {
  return /\/web-draft\//.test(html) || /portal\.kairikos/.test(html) || /href="\/fuentes\//.test(html);
}
