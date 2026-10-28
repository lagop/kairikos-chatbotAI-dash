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

export const SITE_RICH_BLOCK_TYPES = ['galeria', 'antes_despues', 'catalogo'] as const;
export type SiteRichBlockType = (typeof SITE_RICH_BLOCK_TYPES)[number];

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
  return b.fotos.some((f) => f.foto);
}

function head(b: RichBlockInput): string {
  return (b.titulo ? `<h2>${esc(b.titulo)}</h2>` : '') + (b.texto ? `<div class="k-texto">${renderSiteMarkdown(b.texto)}</div>` : '');
}

/** El HTML de un bloque rico. `base` es lo que se antepone a las rutas de
 *  las fotos desde esta página ('' en la portada, '../' en una interior). */
export function renderRichBlock(b: RichBlockInput, base: string): string {
  // Solo las relativas suben de nivel: una absoluta ('/web-draft/…', la de
  // la vista previa del laboratorio) ya apunta bien desde cualquier página.
  const src = (p: string) => esc(p && !/^(?:https?:|\/)/.test(p) ? base + p : p);
  const open = `<section class="k-bloque k-${b.tipo.replace('_', '-')}" id="bloque-${esc(b.id)}"><div class="k-dentro">${head(b)}`;
  const close = '</div></section>';

  if (b.tipo === 'galeria') {
    const items = b.fotos
      .filter((f) => f.foto)
      .map(
        (f) =>
          `<li><a class="k-galeria-foto" href="${src(f.foto)}" data-k-galeria="${esc(b.id)}"${f.texto ? ` data-k-pie="${esc(f.texto)}"` : ''}><img src="${src(f.foto)}" alt="${esc(f.alt)}" loading="lazy"></a>${f.texto ? `<p class="k-pie">${esc(f.texto)}</p>` : ''}</li>`,
      )
      .join('');
    return `${open}<ul class="k-galeria-rejilla">${items}</ul>${close}`;
  }

  if (b.tipo === 'antes_despues') {
    const [antes, despues] = b.fotos.filter((f) => f.foto);
    if (!despues) {
      // Solo una foto: se enseña sola, sin comparador.
      return `${open}<figure class="k-comparador-sola"><img src="${src(antes.foto)}" alt="${esc(antes.alt)}" loading="lazy"></figure>${close}`;
    }
    const la = antes.texto || 'Antes';
    const ld = despues.texto || 'Después';
    return (
      `${open}<figure class="k-comparador" style="--k-pos:50%">` +
      `<img class="k-comparador-antes" src="${src(antes.foto)}" alt="${esc(la)}: ${esc(antes.alt)}" loading="lazy">` +
      `<div class="k-comparador-despues"><img src="${src(despues.foto)}" alt="${esc(ld)}: ${esc(despues.alt)}" loading="lazy"></div>` +
      `<span class="k-comparador-linea" aria-hidden="true"></span>` +
      `<span class="k-etiqueta k-etiqueta--antes" aria-hidden="true">${esc(la)}</span><span class="k-etiqueta k-etiqueta--despues" aria-hidden="true">${esc(ld)}</span>` +
      `<input class="k-comparador-control" type="range" min="0" max="100" value="50" aria-label="Desliza para comparar: ${esc(la)} y ${esc(ld)}">` +
      `</figure>${close}`
    );
  }

  // Catálogo
  const cats = [...new Map(b.productos.filter((p) => p.categoria).map((p) => [slug(p.categoria), p.categoria])).entries()];
  const filtros =
    cats.length > 1
      ? `<div class="k-filtros" role="group" aria-label="Filtrar por categoría" hidden><button type="button" data-k-filtro="" aria-pressed="true">Todo</button>${cats
          .map(([k, label]) => `<button type="button" data-k-filtro="${esc(k)}" aria-pressed="false">${esc(label)}</button>`)
          .join('')}</div>`
      : '';
  const productos = b.productos
    .map((p) => {
      const foto = p.foto ? `<img src="${src(p.foto)}" alt="${esc(p.alt || p.nombre)}" loading="lazy">` : '<div class="k-producto-sin-foto" aria-hidden="true"></div>';
      const caracts = p.caracteristicas.length ? `<ul class="k-caracteristicas">${p.caracteristicas.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';
      return (
        `<li class="k-producto" data-k-categoria="${p.categoria ? esc(slug(p.categoria)) : ''}">${foto}<div class="k-producto-cuerpo">` +
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
.k-precio{margin-top:auto!important;padding-top:.6rem;font-weight:800;font-size:1.15rem;color:var(--k-acento-texto,var(--k-acento,inherit))}
@media (prefers-reduced-motion:reduce){.k-galeria-foto img{transition:none}}
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
})();
</script>`;
