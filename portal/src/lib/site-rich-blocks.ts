import { renderSiteMarkdown } from './site-markdown';

// =============================================================================
// Bloques ricos, tanda 1 (28/10/2026): galería de trabajos, antes y después y
// catálogo de modelos.
//
// Los pinta el MOTOR, no la plantilla. Con cinco plantillas hoy (y las que
// encargue el operador a la IA mañana), una sección nueva diseñada a mano en
// cada una costaría cinco veces y las de la IA no la tendrían nunca. Así:
//
// - El MARCADO es único y sale de aquí.
// - El ASPECTO base también (BLOQUES_CSS), y se inyecta ANTES del <style> de
//   la plantilla, de modo que la plantilla gana si quiere retocar algo. Toma
//   los colores, las esquinas y el ancho de la plantilla por unas pocas
//   variables (--k-acento, --k-superficie, --k-suave…) que cada plantilla
//   declara en su :root. Sin ellas hay valores neutros que se leen en
//   cualquier fondo claro.
// - El COMPORTAMIENTO (ampliar una foto, arrastrar el antes/después, filtrar
//   el catálogo) es un único script (BLOQUES_JS), como el del formulario.
//   Sin JavaScript todo se ve: la foto se abre en su enlace, el comparador
//   queda partido por la mitad y el catálogo enseña todos los modelos.
//
// Las fotos son rutas dentro del sitio (las subidas, site-uploads.ts); el
// motor les antepone lo que haga falta según la profundidad de la página.
// Los datos de ejemplo no se marcan aquí: estos bloques los añade el cliente
// después de comprar, con lo suyo, y la IA del borrador no los genera.
// =============================================================================

// Tanda 2 (28/10/2026): pestañas, comparativa, trayectoria y marcas.
// Tanda 3 (28/10/2026): vídeo que no carga nada de fuera hasta que se pulsa.
export const SITE_RICH_BLOCK_TYPES = ['galeria', 'antes_despues', 'catalogo', 'pestanas', 'comparativa', 'trayectoria', 'marcas', 'video'] as const;
export type SiteRichBlockType = (typeof SITE_RICH_BLOCK_TYPES)[number];

/**
 * Las variables con las que una plantilla le dice al motor cómo pintar estos
 * bloques. Las exige el validador (site-template-validate.ts) y las pide el
 * encargo a la IA (site-template-ai.ts): sin ellas los bloques salen con
 * colores neutros, legibles pero ajenos a la plantilla. --k-radio y
 * --k-margen tienen una reserva razonable y no se exigen.
 */
export const BLOQUES_VARIABLES = [
  { nombre: '--k-acento', para: 'fondo de botones y filtros' },
  { nombre: '--k-sobre-acento', para: 'texto encima de --k-acento' },
  { nombre: '--k-acento-texto', para: 'el acento como texto sobre el fondo de la página, con contraste de 4,5' },
  { nombre: '--k-superficie', para: 'fondo de tarjeta' },
  { nombre: '--k-borde', para: 'filetes y bordes' },
  { nombre: '--k-suave', para: 'texto secundario' },
  { nombre: '--k-ancho', para: 'el ancho de tu contenedor' },
] as const;

export function isRichBlockType(tipo: string): tipo is SiteRichBlockType {
  return (SITE_RICH_BLOCK_TYPES as readonly string[]).includes(tipo);
}

export interface RichBlockInput {
  id: string;
  tipo: SiteRichBlockType;
  titulo: string;
  texto: string;
  fotos: { foto: string; alt: string; texto: string }[];
  productos: { nombre: string; categoria: string; foto: string; alt: string; descripcion: string; caracteristicas: string[]; precio: string }[];
  pestanas: { titulo: string; texto: string; foto: string; alt: string }[];
  comparativa: { columnas: string[]; destacada: number; filas: { concepto: string; valores: string[] }[] };
  hitos: { fecha: string; titulo: string; texto: string }[];
  /** El enlace al vídeo (YouTube o Vimeo); `foto`, la portada propia. */
  video: string;
  foto: string;
  fotoAlt: string;
}

export type VideoPlatform = 'youtube' | 'vimeo';

/**
 * De qué plataforma es un enlace de vídeo y su identificador, o null. Solo
 * YouTube y Vimeo: son las dos que tienen un modo que no instala cookies
 * hasta reproducir (youtube-nocookie.com y el «dnt» de Vimeo).
 */
export function parseVideoUrl(url: string): { plataforma: VideoPlatform; id: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  const yt = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { plataforma: 'youtube' as const, id } : null);
  if (host === 'youtu.be') return yt(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return yt(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/);
    return yt(m?.[1]);
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/^\/(?:video\/)?(\d{6,12})(?:\/|$)/);
    return m ? { plataforma: 'vimeo', id: m[1] } : null;
  }
  return null;
}

/** Las plataformas de vídeo que usa una web: lo necesitan la política de
 *  cookies y la de privacidad (site-legal.ts). */
export function videoPlatformsIn(bloques: { tipo: string; video?: string }[]): VideoPlatform[] {
  const set = new Set<VideoPlatform>();
  for (const b of bloques) {
    if (b.tipo !== 'video' || !b.video) continue;
    const v = parseVideoUrl(b.video);
    if (v) set.add(v.plataforma);
  }
  return [...set].sort();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'otros'
  );
}

/** Si el bloque tiene algo que enseñar. Uno vacío no se pinta. */
export function richBlockHasContent(b: RichBlockInput): boolean {
  if (b.tipo === 'catalogo') return b.productos.length > 0;
  if (b.tipo === 'pestanas') return b.pestanas.length > 0;
  if (b.tipo === 'comparativa') return b.comparativa.columnas.length > 0 && b.comparativa.filas.length > 0;
  if (b.tipo === 'trayectoria') return b.hitos.length > 0;
  if (b.tipo === 'video') return parseVideoUrl(b.video) !== null;
  return b.fotos.some((f) => f.foto);
}

/** El atributo data-k-foto de una foto del bloque ('' fuera del editor). */
type FotoAttr = (path: string) => string;

function head(b: RichBlockInput): string {
  return (b.titulo ? `<h2>${esc(b.titulo)}</h2>` : '') + (b.texto ? `<div class="k-texto">${renderSiteMarkdown(b.texto)}</div>` : '');
}

/** Pestañas. Sin JavaScript son secciones una debajo de otra, cada una con
 *  su título; el script las convierte en pestañas (roles ARIA incluidos) y
 *  oculta los títulos repetidos. */
function renderPestanas(b: RichBlockInput, src: (p: string) => string, foto: FotoAttr, variante?: string): string {
  const paneles = b.pestanas
    .map(
      (t, i) =>
        `<div class="k-panel" id="k-panel-${esc(b.id)}-${i}" data-k-titulo="${esc(t.titulo)}"><h3 class="k-panel-titulo">${esc(t.titulo)}</h3><div class="k-panel-cuerpo${t.foto ? ' k-panel-cuerpo--foto' : ''}">` +
        (t.foto ? `<img${foto(`pestanas.${i}.foto`)} src="${src(t.foto)}" alt="${esc(t.alt)}" loading="lazy">` : '') +
        `<div class="k-panel-texto">${renderSiteMarkdown(t.texto)}</div></div></div>`,
    )
    .join('');
  // 30/10/2026 — el estilo elegido (T1–T3, site-section-variants.ts).
  const estilo = variante && ['subrayado', 'pildora', 'tarjetas'].includes(variante) ? ` k-pestanas--${variante}` : '';
  return `<div class="k-pestanas${estilo}" data-k-pestanas>${paneles}</div>`;
}

/** Una celda de la comparativa: «sí» y «no» se pintan como marca; lo demás,
 *  tal cual. */
function celda(valor: string): string {
  const v = valor.trim().toLowerCase();
  if (v === '') return '';
  if (['sí', 'si', 'yes', '✓', '✔'].includes(v)) return '<span class="k-si" role="img" aria-label="Sí"></span>';
  if (['no', '—', '-', '–', '✗', 'x'].includes(v)) return '<span class="k-no" role="img" aria-label="No"></span>';
  return esc(valor);
}

/** Comparativa: una tabla de verdad. En el móvil cada fila pasa a ser una
 *  tarjeta, con el nombre de la columna delante de cada valor. */
function renderComparativa(b: RichBlockInput): string {
  const { columnas, destacada, filas } = b.comparativa;
  const cls = (i: number) => (i === destacada ? ' class="k-destacada"' : '');
  const cabeza = `<thead><tr><td></td>${columnas.map((c, i) => `<th scope="col"${cls(i)}>${esc(c)}</th>`).join('')}</tr></thead>`;
  const cuerpo = filas
    .map((f) => `<tr><th scope="row">${esc(f.concepto)}</th>${columnas.map((c, i) => `<td data-k-columna="${esc(c)}"${cls(i)}>${celda(f.valores[i] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="k-comparativa-marco"><table class="k-comparativa">${cabeza}<tbody>${cuerpo}</tbody></table></div>`;
}

/** Trayectoria: una línea de tiempo que se dibuja al bajar. */
function renderTrayectoria(b: RichBlockInput): string {
  return `<ol class="k-trayectoria">${b.hitos
    .map((h) => `<li class="k-hito"><p class="k-hito-fecha">${esc(h.fecha)}</p><div class="k-hito-cuerpo"><h3>${esc(h.titulo)}</h3>${h.texto ? `<p>${esc(h.texto)}</p>` : ''}</div></li>`)
    .join('')}</ol>`;
}

/** Marcas y certificados. Con más de cuatro, pasan en cinta (la segunda copia
 *  es solo para que el bucle no tenga salto, y se oculta a los lectores). */
function renderMarcas(b: RichBlockInput, src: (p: string) => string, foto: FotoAttr): string {
  const logos = b.fotos.map((f, i) => ({ ...f, i })).filter((f) => f.foto);
  const items = logos
    .map((f) => `<li><img${foto(`fotos.${f.i}.foto`)} src="${src(f.foto)}" alt="${esc(f.alt)}" loading="lazy">${f.texto ? `<span class="k-marca-texto">${esc(f.texto)}</span>` : ''}</li>`)
    .join('');
  if (logos.length <= 4) return `<div class="k-marcas"><ul class="k-marcas-pista">${items}</ul></div>`;
  return `<div class="k-marcas k-marcas--cinta"><ul class="k-marcas-pista">${items}</ul><ul class="k-marcas-pista" aria-hidden="true">${items.replace(/ alt="[^"]*"/g, ' alt=""')}</ul></div>`;
}

/**
 * Vídeo. Hasta que se pulsa, NADA sale de la web: la portada es la foto del
 * cliente o una de la plantilla (nunca la miniatura de YouTube, que ya le
 * daría a Google la IP del visitante). Sin JavaScript es un enlace al vídeo;
 * con él, al pulsar se cambia por el reproductor en modo privado.
 */
function renderVideo(b: RichBlockInput, src: (p: string) => string, foto: FotoAttr): string {
  const v = parseVideoUrl(b.video);
  if (!v) return '';
  const nombre = v.plataforma === 'youtube' ? 'YouTube' : 'Vimeo';
  const enlace = v.plataforma === 'youtube' ? `https://www.youtube.com/watch?v=${v.id}` : `https://vimeo.com/${v.id}`;
  const portada = b.foto ? `<img${foto('foto')} src="${src(b.foto)}" alt="${esc(b.fotoAlt)}" loading="lazy">` : '<span class="k-video-fondo" aria-hidden="true"></span>';
  return (
    `<div class="k-video-marco" data-k-video="${v.plataforma}" data-k-id="${esc(v.id)}" data-k-titulo="${esc(b.titulo || 'Vídeo')}">` +
    `<a class="k-video-portada" href="${enlace}" target="_blank" rel="noopener">${portada}<span class="k-video-boton" aria-hidden="true"></span><span class="k-video-etiqueta">Reproducir el vídeo</span></a>` +
    `<p class="k-video-aviso">El vídeo se carga desde ${nombre} solo al pulsar; a partir de ahí, ${nombre} puede usar cookies.</p></div>`
  );
}

/** El HTML de un bloque rico. `base` es lo que se antepone a las rutas de
 *  las fotos desde esta página ('' en la portada, '../' en una interior). */
export function renderRichBlock(b: RichBlockInput, base: string, ejemplo = false, edicion = false, variante?: string): string {
  // Solo las relativas suben de nivel: una absoluta ('/web-draft/…', la de
  // la vista previa del laboratorio) ya apunta bien desde cualquier página.
  const src = (p: string) => esc(p && !/^(?:https?:|\/)/.test(p) ? base + p : p);
  // Solo en la vista del editor (29/10/2026): el dato de cada foto, para
  // cambiarla pulsándola (SiteLivePreview). Lo publicado no lo lleva.
  const foto: FotoAttr = (path) => (edicion ? ` data-k-foto="${esc(`bloques.${b.id}.${path}`)}"` : '');
  // De ejemplo (site-sector-blocks.ts): el bloque entero va resaltado con la
  // marca de la plantilla (.dato-ejemplo-bloque).
  const open = `<section class="k-bloque k-${b.tipo.replace('_', '-')}" id="bloque-${esc(b.id)}"><div class="k-dentro">${ejemplo ? '<div class="dato-ejemplo-bloque">' : ''}${head(b)}`;
  const close = `${ejemplo ? '</div>' : ''}</div></section>`;

  if (b.tipo === 'galeria') {
    const items = b.fotos
      .map((f, i) => ({ ...f, i }))
      .filter((f) => f.foto)
      .map(
        (f) =>
          `<li><a class="k-galeria-foto" href="${src(f.foto)}" data-k-galeria="${esc(b.id)}"${f.texto ? ` data-k-pie="${esc(f.texto)}"` : ''}><img${foto(`fotos.${f.i}.foto`)} src="${src(f.foto)}" alt="${esc(f.alt)}" loading="lazy"></a>${f.texto ? `<p class="k-pie">${esc(f.texto)}</p>` : ''}</li>`,
      )
      .join('');
    return `${open}<ul class="k-galeria-rejilla">${items}</ul>${close}`;
  }

  if (b.tipo === 'antes_despues') {
    const [antes, despues] = b.fotos.map((f, i) => ({ ...f, i })).filter((f) => f.foto);
    if (!despues) {
      // Solo una foto: se enseña sola, sin comparador.
      return `${open}<figure class="k-comparador-sola"><img${foto(`fotos.${antes.i}.foto`)} src="${src(antes.foto)}" alt="${esc(antes.alt)}" loading="lazy"></figure>${close}`;
    }
    const la = antes.texto || 'Antes';
    const ld = despues.texto || 'Después';
    return (
      `${open}<figure class="k-comparador" style="--k-pos:50%">` +
      `<img${foto(`fotos.${antes.i}.foto`)} class="k-comparador-antes" src="${src(antes.foto)}" alt="${esc(la)}: ${esc(antes.alt)}" loading="lazy">` +
      `<div class="k-comparador-despues"><img${foto(`fotos.${despues.i}.foto`)} src="${src(despues.foto)}" alt="${esc(ld)}: ${esc(despues.alt)}" loading="lazy"></div>` +
      `<span class="k-comparador-linea" aria-hidden="true"></span>` +
      `<span class="k-etiqueta k-etiqueta--antes" aria-hidden="true">${esc(la)}</span><span class="k-etiqueta k-etiqueta--despues" aria-hidden="true">${esc(ld)}</span>` +
      `<input class="k-comparador-control" type="range" min="0" max="100" value="50" aria-label="Desliza para comparar: ${esc(la)} y ${esc(ld)}">` +
      `</figure>${close}`
    );
  }

  if (b.tipo === 'pestanas') return open + renderPestanas(b, src, foto, variante) + close;
  if (b.tipo === 'comparativa') return open + renderComparativa(b) + close;
  if (b.tipo === 'trayectoria') return open + renderTrayectoria(b) + close;
  if (b.tipo === 'marcas') return open + renderMarcas(b, src, foto) + close;
  if (b.tipo === 'video') return open + renderVideo(b, src, foto) + close;

  // Catálogo
  const cats = [...new Map(b.productos.filter((p) => p.categoria).map((p) => [slug(p.categoria), p.categoria])).entries()];
  const filtros =
    cats.length > 1
      ? `<div class="k-filtros" role="group" aria-label="Filtrar por categoría" hidden><button type="button" data-k-filtro="" aria-pressed="true">Todo</button>${cats
          .map(([k, label]) => `<button type="button" data-k-filtro="${esc(k)}" aria-pressed="false">${esc(label)}</button>`)
          .join('')}</div>`
      : '';
  // 30/10/2026 — si ninguno tiene foto (el equipo de una clínica, site-sector-
  // blocks.ts), tarjetas solo de texto: una fila de cuadros rayados parecía
  // una web a medio hacer. El hueco rayado queda para el que le falta la suya
  // entre otros que sí la tienen, para que la rejilla no se descuadre.
  const conFotos = b.productos.some((p) => p.foto);
  const productos = b.productos
    .map((p, i) => {
      const img = p.foto
        ? `<img${foto(`productos.${i}.foto`)} src="${src(p.foto)}" alt="${esc(p.alt || p.nombre)}" loading="lazy">`
        : conFotos
          ? '<div class="k-producto-sin-foto" aria-hidden="true"></div>'
          : '';
      const caracts = p.caracteristicas.length ? `<ul class="k-caracteristicas">${p.caracteristicas.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';
      return (
        `<li class="k-producto" data-k-categoria="${p.categoria ? esc(slug(p.categoria)) : ''}">${img}<div class="k-producto-cuerpo">` +
        (p.categoria ? `<p class="k-producto-categoria">${esc(p.categoria)}</p>` : '') +
        `<h3>${esc(p.nombre)}</h3>${p.descripcion ? `<p>${esc(p.descripcion)}</p>` : ''}${caracts}${p.precio ? `<p class="k-precio">${esc(p.precio)}</p>` : ''}</div></li>`
      );
    })
    .join('');
  return `${open}${filtros}<ul class="k-catalogo-rejilla">${productos}</ul>${close}`;
}

/**
 * El aspecto base. Va ANTES del <style> de la plantilla: lo que la plantilla
 * diga de estas clases gana. Las variables --k-* las declara la plantilla en
 * su :root (ver las de oficios); estas son las de reserva.
 */
export const BLOQUES_CSS = `<style id="bloques-kairikos">
.k-bloque{padding-block:clamp(3rem,7vw,5.5rem)}
.k-dentro{width:min(100% - 2*var(--k-margen,1.5rem),var(--k-ancho,1200px));margin-inline:auto}
.k-dentro>h2{margin-top:0}
.k-texto{max-width:62ch;margin-bottom:1.75rem;overflow-wrap:anywhere}
.k-galeria-rejilla,.k-catalogo-rejilla{list-style:none;margin:0;padding:0;display:grid;gap:var(--k-hueco,1rem)}
.k-galeria-rejilla{grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))}
.k-galeria-rejilla>li{min-width:0}
.k-galeria-foto{display:block;overflow:hidden;border-radius:var(--k-radio,8px);background:var(--k-superficie,#eee);cursor:zoom-in}
.k-galeria-foto img{width:100%;aspect-ratio:4/3;object-fit:cover;transition:transform .5s ease}
.k-galeria-foto:hover img,.k-galeria-foto:focus-visible img{transform:scale(1.05)}
.k-galeria-foto:focus-visible{outline:3px solid var(--k-acento,#222);outline-offset:3px}
.k-pie{margin:.5rem 0 0;font-size:.92rem;color:var(--k-suave,inherit);overflow-wrap:anywhere}
.k-visor{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(10,12,14,.94);color:#fff;padding:3.5rem 1rem 4.5rem}
.k-visor[hidden]{display:none}
.k-visor img{max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;user-select:none;touch-action:pan-y}
.k-visor-pie{position:absolute;left:1rem;right:1rem;bottom:1.25rem;text-align:center;margin:0;font-size:.95rem}
.k-visor button{position:absolute;display:grid;place-items:center;width:3rem;height:3rem;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font:400 1.6rem/1 system-ui,sans-serif;cursor:pointer}
.k-visor button:hover,.k-visor button:focus-visible{background:rgba(255,255,255,.3);outline:none}
.k-visor-cerrar{top:.75rem;right:.75rem}
.k-visor-ant{left:.75rem;top:50%;margin-top:-1.5rem}
.k-visor-sig{right:.75rem;top:50%;margin-top:-1.5rem}
.k-comparador,.k-comparador-sola{position:relative;margin:0;overflow:hidden;border-radius:var(--k-radio,8px);background:var(--k-superficie,#eee);max-width:62rem}
.k-comparador img,.k-comparador-sola img{display:block;width:100%;aspect-ratio:3/2;object-fit:cover}
.k-comparador-despues{position:absolute;inset:0;clip-path:inset(0 0 0 var(--k-pos))}
.k-comparador-linea{position:absolute;top:0;bottom:0;left:var(--k-pos);width:3px;margin-left:-1.5px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);pointer-events:none}
.k-comparador-linea::after{content:"";position:absolute;left:50%;top:50%;width:2.75rem;height:2.75rem;margin:-1.375rem 0 0 -1.375rem;border-radius:50%;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9 6l-6 6 6 6M15 6l6 6-6 6' fill='none' stroke='%23222' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/1.4rem no-repeat;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.k-etiqueta{position:absolute;top:.75rem;padding:.3rem .65rem;border-radius:4px;background:#111;color:#fff;font:600 .8rem/1.2 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;pointer-events:none}
.k-etiqueta--antes{left:.75rem}
.k-etiqueta--despues{right:.75rem}
.k-comparador-control{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:ew-resize;touch-action:pan-y}
.k-comparador:has(.k-comparador-control:focus-visible) .k-comparador-linea{box-shadow:0 0 0 3px var(--k-acento,#222)}
.k-filtros{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.5rem}
.k-filtros button{font:inherit;font-weight:600;font-size:.95rem;padding:.55rem 1rem;border-radius:999px;border:1px solid var(--k-borde,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;transition:background .2s ease,color .2s ease,border-color .2s ease}
.k-filtros button[aria-pressed="true"]{background:var(--k-acento,#222);border-color:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.k-catalogo-rejilla{grid-template-columns:repeat(auto-fill,minmax(min(100%,16.5rem),1fr))}
.k-producto{display:flex;flex-direction:column;min-width:0;overflow:hidden;border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:1px solid var(--k-borde,rgba(127,127,127,.25))}
.k-producto[hidden]{display:none}
.k-producto img,.k-producto-sin-foto{width:100%;aspect-ratio:4/3;object-fit:cover}
.k-producto-sin-foto{background:repeating-linear-gradient(135deg,var(--k-borde,rgba(127,127,127,.2)) 0 1px,transparent 1px 12px)}
.k-producto-cuerpo{display:flex;flex-direction:column;gap:.4rem;padding:1.1rem 1.2rem 1.3rem;flex:1;overflow-wrap:anywhere}
.k-producto-cuerpo h3{margin:0}
.k-producto-cuerpo p{margin:0}
.k-producto-categoria{font-size:.75rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--k-acento-texto,var(--k-acento,inherit))}
.k-producto-cuerpo>p:not([class]){color:var(--k-suave,inherit)}
.k-caracteristicas{list-style:none;margin:.3rem 0 0;padding:0;display:grid;gap:.3rem;font-size:.95rem}
.k-caracteristicas li{position:relative;padding-left:1.4rem}
.k-caracteristicas li::before{content:"";position:absolute;left:0;top:.35em;width:.8rem;height:.45rem;border-left:2px solid var(--k-acento-texto,var(--k-acento,currentColor));border-bottom:2px solid var(--k-acento-texto,var(--k-acento,currentColor));transform:rotate(-45deg)}
.k-pestanas-lista{display:flex;flex-wrap:wrap;gap:.25rem;margin:0 0 1.5rem;border-bottom:2px solid var(--k-borde,rgba(127,127,127,.3))}
.k-pestanas-lista button{font:inherit;font-weight:600;padding:.7rem 1.1rem;margin-bottom:-2px;border:0;border-bottom:2px solid transparent;background:transparent;color:inherit;cursor:pointer;transition:color .2s ease,border-color .2s ease}
.k-pestanas-lista button[aria-selected="true"]{border-bottom-color:var(--k-acento,#222);color:var(--k-acento-texto,var(--k-acento,inherit))}
.k-pestanas-lista button:focus-visible{outline:2px solid var(--k-acento,#222);outline-offset:2px}
.k-pestanas--subrayado .k-pestanas-lista{position:relative}
.k-pestanas--subrayado .k-pestanas-lista button[aria-selected="true"]{border-bottom-color:transparent}
.k-pestanas-raya{position:absolute;left:0;bottom:-2px;height:3px;width:0;border-radius:3px;background:var(--k-acento,#222);transition:transform .35s cubic-bezier(.3,.7,.2,1),width .35s cubic-bezier(.3,.7,.2,1)}
.k-pestanas--pildora .k-pestanas-lista{display:inline-flex;max-width:100%;padding:.3rem;gap:.25rem;border:1px solid var(--k-borde,rgba(127,127,127,.3));border-radius:1.6rem;background:var(--k-superficie,transparent)}
.k-pestanas--pildora .k-pestanas-lista button{margin:0;border:0;border-radius:1.3rem;padding:.6rem 1.15rem}
.k-pestanas--pildora .k-pestanas-lista button[aria-selected="true"]{background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.k-pestanas--tarjetas .k-pestanas-lista{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:.6rem;border:0}
.k-pestanas--tarjetas .k-pestanas-lista button{margin:0;padding:1rem;border:1px solid var(--k-borde,rgba(127,127,127,.3));border-radius:var(--k-radio,8px);background:var(--k-superficie,transparent);text-align:left;transition:transform .2s ease,background .2s ease}
.k-pestanas--tarjetas .k-pestanas-lista button:hover{transform:translateY(-2px)}
.k-pestanas--tarjetas .k-pestanas-lista button[aria-selected="true"]{background:var(--k-acento,#222);border-color:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.k-pestanas--tarjetas.k-pestanas--js .k-panel{padding:1.5rem;border:1px solid var(--k-borde,rgba(127,127,127,.3));border-radius:var(--k-radio,8px)}
.k-panel+.k-panel{margin-top:2rem}
.k-pestanas--js .k-panel+.k-panel{margin-top:0}
.k-pestanas--js .k-panel-titulo{display:none}
.k-panel[hidden]{display:none}
.k-panel-cuerpo{display:grid;gap:1.5rem 2.5rem;grid-template-columns:minmax(0,1fr);align-items:start;overflow-wrap:anywhere}
.k-panel-cuerpo--foto{grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))}
.k-panel-cuerpo>*{min-width:0}
.k-panel-cuerpo img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--k-radio,8px)}
.k-panel-texto>:first-child{margin-top:0}
.k-comparativa-marco{max-width:100%}
.k-comparativa{width:100%;border-collapse:collapse;background:var(--k-superficie,transparent);border-radius:var(--k-radio,8px);overflow:hidden}
.k-comparativa th,.k-comparativa td{padding:.85rem 1rem;text-align:center;border-bottom:1px solid var(--k-borde,rgba(127,127,127,.25));overflow-wrap:break-word;hyphens:auto}
.k-comparativa thead th{font-weight:700;font-size:1.05rem}
.k-comparativa tbody th{text-align:left;font-weight:600}
.k-comparativa .k-destacada{background:color-mix(in srgb,var(--k-acento,#888) 10%,var(--k-superficie,#fff))}
.k-comparativa thead .k-destacada{background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.k-si,.k-no{display:inline-block;width:1.4rem;height:1.4rem;border-radius:50%;vertical-align:middle;position:relative}
.k-si{background:color-mix(in srgb,var(--k-acento,#2e7d32) 16%,transparent)}
.k-si::after{content:"";position:absolute;left:.48rem;top:.25rem;width:.4rem;height:.7rem;border-right:2px solid var(--k-acento-texto,var(--k-acento,#2e7d32));border-bottom:2px solid var(--k-acento-texto,var(--k-acento,#2e7d32));transform:rotate(45deg)}
.k-no::after{content:"";position:absolute;left:.35rem;right:.35rem;top:50%;height:2px;margin-top:-1px;background:currentColor;opacity:.45}
@media (max-width:640px){
.k-comparativa thead{display:none}
.k-comparativa,.k-comparativa tbody,.k-comparativa tr,.k-comparativa th,.k-comparativa td{display:block;width:100%}
.k-comparativa tr{border-bottom:1px solid var(--k-borde,rgba(127,127,127,.25));padding:.75rem 1rem}
.k-comparativa th,.k-comparativa td{padding:.3rem 0;border:0;text-align:left}
.k-comparativa tbody th{font-size:1.05rem;padding-bottom:.4rem}
.k-comparativa td{display:flex;justify-content:space-between;gap:1rem}
.k-comparativa td::before{content:attr(data-k-columna);font-weight:600}
.k-comparativa .k-destacada{background:transparent}}
.k-trayectoria{position:relative;isolation:isolate;list-style:none;margin:0;padding:0 0 0 1.75rem;display:grid;gap:2rem;max-width:56rem}
.k-trayectoria::before{content:"";position:absolute;z-index:-1;left:.45rem;top:.5rem;bottom:.5rem;width:2px;background:var(--k-borde,rgba(127,127,127,.35))}
.k-hito{position:relative;display:grid;gap:.25rem 2rem;min-width:0}
.k-hito::before{content:"";position:absolute;z-index:-1;left:-1.75rem;top:.35rem;width:1rem;height:1rem;border-radius:50%;background:var(--k-acento,#222);box-shadow:0 0 0 4px var(--k-superficie,#fff)}
.k-hito-fecha{margin:0;font-weight:800;font-size:1.15rem;color:var(--k-acento-texto,var(--k-acento,inherit));overflow-wrap:anywhere}
.k-hito-cuerpo{min-width:0;overflow-wrap:anywhere}
.k-hito-cuerpo h3{margin:0 0 .3rem}
.k-hito-cuerpo p{margin:0;color:var(--k-suave,inherit)}
@media (min-width:760px){.k-hito{grid-template-columns:9rem minmax(0,1fr)}}
.k-js .k-hito{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .7s ease}
.k-js .k-hito.k-visto{opacity:1;transform:none}
.k-marcas{overflow:hidden}
.k-marcas-pista{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:1.5rem 3rem}
.k-marcas-pista li{display:flex;flex-direction:column;align-items:center;gap:.4rem;min-width:0}
.k-marcas-pista img{height:3.25rem;width:auto;max-width:11rem;object-fit:contain;filter:grayscale(1);opacity:.8;transition:filter .3s ease,opacity .3s ease}
.k-marcas-pista li:hover img{filter:none;opacity:1}
.k-marca-texto{font-size:.8rem;font-weight:600;text-align:center}
.k-marcas--cinta{display:flex;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.k-marcas--cinta .k-marcas-pista{flex:none;flex-wrap:nowrap;padding-right:3rem;animation:k-cinta 32s linear infinite}
.k-marcas--cinta:hover .k-marcas-pista{animation-play-state:paused}
@keyframes k-cinta{to{transform:translateX(-100%)}}
.k-video-marco{max-width:62rem}
.k-video-portada,.k-video-marco iframe{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:var(--k-radio,8px);overflow:hidden}
.k-video-portada{position:relative;background:#111;color:#fff;text-decoration:none}
.k-video-portada img{width:100%;height:100%;object-fit:cover;transition:transform .5s ease,filter .3s ease}
.k-video-portada:hover img{transform:scale(1.03);filter:brightness(.85)}
.k-video-fondo{position:absolute;inset:0;background:radial-gradient(circle at 30% 30%,color-mix(in srgb,var(--k-acento,#444) 55%,#000),#0d0f12 70%)}
.k-video-boton{position:absolute;left:50%;top:50%;width:4.75rem;height:4.75rem;margin:-2.375rem 0 0 -2.375rem;border-radius:50%;background:var(--k-acento,#e11);box-shadow:0 8px 30px rgba(0,0,0,.35);transition:transform .25s ease}
.k-video-boton::after{content:"";position:absolute;left:52%;top:50%;margin:-.9rem 0 0 -.6rem;border-style:solid;border-width:.9rem 0 .9rem 1.5rem;border-color:transparent transparent transparent var(--k-sobre-acento,#fff)}
.k-video-portada:hover .k-video-boton,.k-video-portada:focus-visible .k-video-boton{transform:scale(1.08)}
.k-video-portada:focus-visible{outline:3px solid var(--k-acento,#222);outline-offset:3px}
.k-video-etiqueta{position:absolute;left:1rem;bottom:1rem;padding:.4rem .75rem;border-radius:4px;background:#111;color:#fff;font:600 .9rem/1.2 system-ui,sans-serif}
.k-video-aviso{margin:.6rem 0 0;font-size:.85rem;color:var(--k-suave,inherit)}
.k-precio{margin-top:auto!important;padding-top:.6rem;font-weight:800;font-size:1.15rem;color:var(--k-acento-texto,var(--k-acento,inherit))}
@media (prefers-reduced-motion:reduce){.k-galeria-foto img{transition:none}.k-js .k-hito{opacity:1;transform:none;transition:none}.k-marcas--cinta{display:block;-webkit-mask-image:none;mask-image:none}.k-marcas--cinta .k-marcas-pista{flex-wrap:wrap;animation:none;padding-right:0}.k-marcas--cinta .k-marcas-pista[aria-hidden]{display:none}}
</style>`;

/** El comportamiento. Solo aspecto: sin peticiones ni almacenamiento. */
export const BLOQUES_JS = `<script>
(function () {
  // El visor de la galería: uno para toda la página.
  var visor = null, fotos = [], actual = 0, origen = null;
  function abrir(lista, i, desde) {
    fotos = lista; actual = i; origen = desde;
    if (!visor) {
      visor = document.createElement("div");
      visor.className = "k-visor"; visor.hidden = true;
      visor.setAttribute("role", "dialog"); visor.setAttribute("aria-modal", "true"); visor.setAttribute("aria-label", "Foto ampliada");
      visor.innerHTML = '<img alt=""><p class="k-visor-pie"></p><button type="button" class="k-visor-cerrar" aria-label="Cerrar">\\u00d7</button><button type="button" class="k-visor-ant" aria-label="Foto anterior">\\u2039</button><button type="button" class="k-visor-sig" aria-label="Foto siguiente">\\u203a</button>';
      document.body.appendChild(visor);
      visor.querySelector(".k-visor-cerrar").addEventListener("click", cerrar);
      visor.querySelector(".k-visor-ant").addEventListener("click", function () { mover(-1); });
      visor.querySelector(".k-visor-sig").addEventListener("click", function () { mover(1); });
      visor.addEventListener("click", function (e) { if (e.target === visor) cerrar(); });
      var x0 = null;
      visor.addEventListener("pointerdown", function (e) { x0 = e.clientX; });
      visor.addEventListener("pointerup", function (e) { if (x0 !== null && Math.abs(e.clientX - x0) > 40) mover(e.clientX < x0 ? 1 : -1); x0 = null; });
      document.addEventListener("keydown", function (e) {
        if (!visor || visor.hidden) return;
        if (e.key === "Escape") cerrar(); else if (e.key === "ArrowRight") mover(1); else if (e.key === "ArrowLeft") mover(-1);
      });
    }
    pintar(); visor.hidden = false; document.documentElement.style.overflow = "hidden";
    visor.querySelector(".k-visor-cerrar").focus();
  }
  function pintar() {
    var a = fotos[actual], img = visor.querySelector("img");
    img.src = a.href; img.alt = a.querySelector("img").alt;
    visor.querySelector(".k-visor-pie").textContent = a.getAttribute("data-k-pie") || "";
    var varias = fotos.length > 1;
    visor.querySelector(".k-visor-ant").hidden = !varias; visor.querySelector(".k-visor-sig").hidden = !varias;
  }
  function mover(d) { actual = (actual + d + fotos.length) % fotos.length; pintar(); }
  function cerrar() { visor.hidden = true; document.documentElement.style.overflow = ""; if (origen) origen.focus(); }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-k-galeria]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    var lista = Array.prototype.slice.call(document.querySelectorAll('a[data-k-galeria="' + a.getAttribute("data-k-galeria") + '"]'));
    abrir(lista, lista.indexOf(a), a);
  });

  // Antes y después: el control mueve la línea.
  document.querySelectorAll(".k-comparador").forEach(function (f) {
    var control = f.querySelector(".k-comparador-control");
    if (control) control.addEventListener("input", function () { f.style.setProperty("--k-pos", control.value + "%"); });
  });

  // El catálogo: los filtros solo existen con JavaScript.
  document.querySelectorAll(".k-catalogo").forEach(function (cat) {
    var filtros = cat.querySelector(".k-filtros");
    if (!filtros) return;
    filtros.hidden = false;
    filtros.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-k-filtro]");
      if (!b) return;
      var k = b.getAttribute("data-k-filtro");
      filtros.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      cat.querySelectorAll(".k-producto").forEach(function (p) { p.hidden = !!k && p.getAttribute("data-k-categoria") !== k; });
    });
  });
  // Pestañas: las secciones pasan a pestañas, con sus roles y las flechas.
  document.querySelectorAll("[data-k-pestanas]").forEach(function (cont) {
    var paneles = Array.prototype.slice.call(cont.querySelectorAll(".k-panel"));
    if (paneles.length < 2) return;
    var lista = document.createElement("div");
    lista.className = "k-pestanas-lista"; lista.setAttribute("role", "tablist");
    var botones = paneles.map(function (p, i) {
      var b = document.createElement("button");
      b.type = "button"; b.id = p.id + "-tab"; b.textContent = p.getAttribute("data-k-titulo");
      b.setAttribute("role", "tab"); b.setAttribute("aria-controls", p.id);
      p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", b.id); p.tabIndex = 0;
      b.addEventListener("click", function () { elegir(i, false); });
      lista.appendChild(b);
      return b;
    });
    function elegir(i, foco) {
      botones.forEach(function (b, j) { b.setAttribute("aria-selected", j === i ? "true" : "false"); b.tabIndex = j === i ? 0 : -1; paneles[j].hidden = j !== i; });
      if (foco) botones[i].focus();
    }
    lista.addEventListener("keydown", function (e) {
      var i = botones.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === "ArrowRight") { e.preventDefault(); elegir((i + 1) % botones.length, true); }
      if (e.key === "ArrowLeft") { e.preventDefault(); elegir((i - 1 + botones.length) % botones.length, true); }
    });
    cont.insertBefore(lista, paneles[0]);
    cont.classList.add("k-pestanas--js");
    // T1: la raya que se desliza hasta la pestaña elegida.
    if (cont.classList.contains("k-pestanas--subrayado")) {
      var raya = document.createElement("span");
      raya.className = "k-pestanas-raya"; raya.setAttribute("aria-hidden", "true");
      lista.appendChild(raya);
      var mover = function () {
        var b = lista.querySelector('[aria-selected="true"]');
        if (!b) return;
        raya.style.width = b.offsetWidth + "px";
        raya.style.transform = "translate(" + b.offsetLeft + "px," + (b.offsetTop + b.offsetHeight - lista.offsetHeight) + "px)";
      };
      lista.addEventListener("click", mover); lista.addEventListener("keyup", mover); window.addEventListener("resize", mover);
      requestAnimationFrame(mover);
    }
    elegir(0, false);
  });

  // Vídeo: al pulsar, el reproductor en modo privado. Antes, nada de fuera.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest(".k-video-portada");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var marco = a.parentNode, id = marco.getAttribute("data-k-id"), yt = marco.getAttribute("data-k-video") === "youtube";
    e.preventDefault();
    var f = document.createElement("iframe");
    f.src = yt ? "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0" : "https://player.vimeo.com/video/" + id + "?autoplay=1&dnt=1";
    f.title = marco.getAttribute("data-k-titulo") || "Vídeo";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.setAttribute("allowfullscreen", "");
    f.referrerPolicy = "strict-origin-when-cross-origin";
    marco.replaceChild(f, a);
    f.focus();
  });

  // La trayectoria aparece hito a hito al bajar.
  var hitos = document.querySelectorAll(".k-hito");
  if (hitos.length && "IntersectionObserver" in window && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    document.documentElement.classList.add("k-js");
    var obsHitos = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("k-visto"); obsHitos.unobserve(en.target); } });
    }, { rootMargin: "0px 0px -10% 0px" });
    hitos.forEach(function (h) { obsHitos.observe(h); });
  }
})();
</script>`;
