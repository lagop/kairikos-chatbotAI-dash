import type { SiteTemplateSource } from './site-template';

// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — la plantilla base, escrita a mano.
//
// Tres usos: (1) el ejemplo del formato que se le enseña a la IA cuando
// diseña plantillas nuevas (entrega 2); (2) el plan B cuando una plantilla
// generada no pasa las comprobaciones después de las rondas de corrección;
// (3) el banco de pruebas del motor y del validador.
//
// Sin sector a propósito: colores sobrios por variables CSS, iconos genéricos
// y ningún motivo gráfico de oficio. Las del sector las hace la IA.
//
// Reglas que cumple y que tiene que cumplir cualquier plantilla (las mismas
// que vigilan site-template-validate.ts y las comprobaciones con navegador):
// rejillas con auto-FIT para que las filas llenen el ancho; min-width:0 y
// overflow-wrap en los textos del cliente; menú en una línea con cinco
// enlaces como mucho y desplegable por debajo de 1100 px; la portada visible
// al instante y las animaciones solo si el JavaScript arrancó; todo apagado
// con prefers-reduced-motion; ninguna cifra escrita en la plantilla.
// =============================================================================

const MARCO = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{pagina.meta_titulo}}</title>
<meta name="description" content="{{pagina.meta_descripcion}}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--tinta:#14283d;--tinta-suave:#41566b;--marca:#16324f;--acento:#b4501f;--acento-claro:#fbe9dd;--papel:#faf7f2;--blanco:#fff;--borde:#e6dfd4;
--s-1:.25rem;--s-2:.5rem;--s-3:.75rem;--s-4:1rem;--s-5:1.5rem;--s-6:2rem;--s-7:3rem;--s-8:5rem;--radio:16px;--sombra:0 1px 2px rgba(20,40,61,.06),0 8px 24px rgba(20,40,61,.08);
--display:"Fraunces",Georgia,serif;--texto:"Inter",system-ui,sans-serif;--ancho:1160px}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--papel);color:var(--tinta);font:400 1.0625rem/1.65 var(--texto)}
img{max-width:100%;display:block}
a{color:var(--marca)}
h1,h2,h3{font-family:var(--display);line-height:1.15;margin:0 0 var(--s-4);overflow-wrap:anywhere}
h2{font-size:clamp(1.8rem,3.4vw,2.6rem)}
p{margin:0 0 var(--s-4)}
:focus-visible{outline:3px solid var(--acento);outline-offset:3px}
.saltar{position:absolute;left:-9999px}.saltar:focus{left:var(--s-4);top:var(--s-4);z-index:100;background:var(--blanco);padding:var(--s-2) var(--s-4)}
.contenedor{width:min(100% - 2*var(--s-5),var(--ancho));margin-inline:auto}
.seccion{padding-block:var(--s-8)}
.seccion--alt{background:var(--blanco)}
.rotulo{display:inline-block;font:600 .8rem/1 var(--texto);letter-spacing:.12em;text-transform:uppercase;color:var(--acento);margin-bottom:var(--s-3)}
.lead{max-width:62ch;color:var(--tinta-suave)}
.rejilla{display:grid;gap:var(--s-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))}
.rejilla>*{min-width:0}
.tarjeta{background:var(--blanco);border:1px solid var(--borde);border-radius:var(--radio);padding:var(--s-5);box-shadow:var(--sombra);display:flex;flex-direction:column;transition:transform .25s ease,box-shadow .25s ease}
.tarjeta:hover{transform:translateY(-4px);box-shadow:0 14px 34px rgba(20,40,61,.14)}
.tarjeta p:last-child{margin-bottom:0}
.icono{width:2.75rem;height:2.75rem;border-radius:12px;background:var(--acento-claro);color:var(--acento);display:grid;place-items:center;margin-bottom:var(--s-4);transition:transform .25s ease}
.tarjeta:hover .icono{transform:rotate(-6deg) scale(1.06)}
.icono svg{width:1.5rem;height:1.5rem}
.boton{display:inline-flex;align-items:center;gap:var(--s-2);background:var(--acento);color:var(--blanco);font-weight:600;text-decoration:none;border-radius:999px;padding:var(--s-3) var(--s-5);border:0;cursor:pointer;transition:background .2s ease,transform .2s ease}
.boton:hover{background:#9a4318;transform:translateY(-1px)}
.boton--claro{background:transparent;color:var(--marca);border:2px solid var(--marca)}
.boton svg{width:1.1rem;height:1.1rem}
.cabecera{position:sticky;top:0;z-index:50;background:rgba(250,247,242,.94);backdrop-filter:blur(6px);border-bottom:1px solid transparent;transition:box-shadow .2s ease,border-color .2s ease}
.cabecera.con-sombra{box-shadow:0 6px 18px rgba(20,40,61,.08);border-color:var(--borde)}
.cabecera .contenedor{display:flex;align-items:center;gap:var(--s-5);min-height:4.5rem}
.marca{font:700 1.25rem/1.1 var(--display);color:var(--marca);text-decoration:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu{display:flex;gap:var(--s-5);margin-left:auto}
.menu a{white-space:nowrap;text-decoration:none;color:var(--tinta);font-weight:500;background:linear-gradient(var(--acento),var(--acento)) 0 100%/0 2px no-repeat;transition:background-size .25s ease}
.menu a:hover,.menu a[aria-current]{background-size:100% 2px}
.cabecera .boton{flex-shrink:0}
.abrir-menu{display:none;margin-left:auto;background:none;border:2px solid var(--marca);border-radius:10px;width:2.75rem;height:2.75rem;color:var(--marca);cursor:pointer}
@media (max-width:1099px){.menu{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;gap:0;background:var(--papel);border-bottom:1px solid var(--borde);padding:var(--s-2) var(--s-5) var(--s-5)}
.menu.abierto{display:flex}.menu a{padding:var(--s-3) 0}.abrir-menu{display:grid;place-items:center}.cabecera .boton span{display:none}}
.portada{padding-block:var(--s-7) var(--s-8);background:radial-gradient(circle at 85% 20%,var(--acento-claro),transparent 55%)}
.portada .contenedor{display:grid;gap:var(--s-7);grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));align-items:center}
.portada .contenedor>*{min-width:0}
.portada h1{font-size:clamp(2.2rem,5vw,3.6rem)}
.portada .acciones{display:flex;flex-wrap:wrap;gap:var(--s-3);margin-top:var(--s-5)}
.foto{position:relative;margin:0}
.foto img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:28px;box-shadow:var(--sombra)}
.foto::before{content:"";position:absolute;inset:auto -14px -14px auto;width:60%;height:60%;border-radius:28px;background:var(--acento-claro);z-index:-1;animation:flotar 7s ease-in-out infinite}
.foto figcaption{font-size:.8rem;color:var(--tinta-suave);margin-top:var(--s-2)}
.valoracion{position:absolute;left:-12px;bottom:var(--s-6);background:var(--blanco);border-radius:14px;padding:var(--s-3) var(--s-4);box-shadow:var(--sombra);font-weight:600}
@keyframes flotar{50%{transform:translate(-8px,-10px)}}
.banda{background:var(--marca);color:var(--blanco);padding-block:var(--s-7)}
.banda .rejilla{text-align:center}
.cifra{font:700 clamp(2rem,4vw,2.8rem)/1.1 var(--display);display:block}
.pasos{counter-reset:paso;display:grid;gap:var(--s-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));list-style:none;padding:0;margin:0}
.pasos li{position:relative;padding-top:var(--s-7);min-width:0}
.pasos li::before{counter-increment:paso;content:counter(paso);position:absolute;top:0;left:0;width:2.5rem;height:2.5rem;border-radius:50%;background:var(--acento);color:var(--blanco);display:grid;place-items:center;font-weight:700}
.pasos li::after{content:"";position:absolute;top:1.2rem;left:3rem;right:0;height:2px;background:var(--borde)}
.pasos li:last-child::after{display:none}
.precio{font:700 1.5rem/1.2 var(--display);color:var(--acento);margin-top:auto;padding-top:var(--s-3)}
.nota{font-size:.9rem;color:var(--tinta-suave);margin-top:var(--s-5)}
.preguntas{display:grid;gap:var(--s-3);max-width:52rem}
.preguntas details{background:var(--blanco);border:1px solid var(--borde);border-radius:12px;padding:var(--s-4) var(--s-5)}
.preguntas summary{cursor:pointer;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:var(--s-4);overflow-wrap:anywhere}
.preguntas summary::after{content:"+";color:var(--acento);font-size:1.4rem;line-height:1;transition:transform .2s ease}
.preguntas details[open] summary::after{transform:rotate(45deg)}
.citas{list-style:none;padding:0;margin:var(--s-5) 0}
.cita{background:var(--marca);color:var(--blanco);border-radius:var(--radio);padding:var(--s-5);display:flex;flex-direction:column}
.cita h3{font-size:1.1rem}
.cita p{margin:0 0 var(--s-3)}
.cita-autor{margin-top:auto;font-size:.85rem;color:#d7e0ea}
.resena{margin:0;background:var(--blanco);border:1px solid var(--borde);border-radius:var(--radio);padding:var(--s-5);display:flex;flex-direction:column}
.resena blockquote{margin:var(--s-2) 0 var(--s-3)}
.resena figcaption{margin-top:auto;font-size:.85rem;color:var(--tinta-suave)}
.resena-estrellas{color:#b07800;letter-spacing:.1em}
.atribucion-google{font-size:.85rem;color:var(--tinta-suave);margin-top:var(--s-4)}
.chips{display:flex;flex-wrap:wrap;gap:var(--s-2);list-style:none;padding:0;margin:var(--s-5) 0 0}
.chips li{background:var(--blanco);border:1px solid var(--borde);border-radius:999px;padding:var(--s-1) var(--s-4)}
.llamada{background:var(--acento);color:var(--blanco);text-align:center;padding-block:var(--s-8)}
.llamada a.telefono{font:700 clamp(2rem,6vw,3.4rem)/1.1 var(--display);color:var(--blanco);text-decoration:none;display:inline-block;margin-top:var(--s-3)}
.contacto{display:grid;gap:var(--s-7);grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))}
.contacto>*{min-width:0}
.contacto table{border-collapse:collapse;margin-top:var(--s-4)}
.contacto th{text-align:left;padding:var(--s-1) var(--s-4) var(--s-1) 0;font-weight:500}
form label{display:block;font-weight:600;margin:var(--s-4) 0 var(--s-1)}
form input,form textarea{width:100%;font:inherit;padding:var(--s-3);border:1px solid var(--borde);border-radius:10px;background:var(--blanco)}
form .boton{margin-top:var(--s-5)}
form .boton[disabled]{opacity:.6;cursor:not-allowed}
.partida{display:grid;gap:var(--s-7);grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));align-items:center}
.partida>*{min-width:0}
.partida img{border-radius:var(--radio);width:100%;aspect-ratio:4/3;object-fit:cover}
.aviso{background:var(--acento-claro);border-left:6px solid var(--acento);border-radius:12px;padding:var(--s-5);font-weight:500}
.lista-iconos{display:grid;gap:var(--s-3);grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));list-style:none;padding:0}
.lista-iconos li{display:flex;gap:var(--s-3);align-items:flex-start;min-width:0;overflow-wrap:anywhere}
.lista-iconos svg{flex:none;width:1.4rem;height:1.4rem;color:var(--acento)}
.pie{background:var(--marca);color:#d7e0ea;padding-block:var(--s-6);font-size:.95rem}
.pie a{color:var(--blanco)}
.dato-ejemplo{text-decoration:underline dashed var(--acento);text-underline-offset:3px}
.dato-ejemplo::after{content:"ejemplo";font:600 .62rem/1 var(--texto);text-transform:uppercase;letter-spacing:.06em;background:#fde68a;color:#5b4500;border-radius:4px;padding:2px 4px;margin-left:4px;vertical-align:middle}
.dato-ejemplo-bloque{outline:2px dashed #e0b200;outline-offset:6px;border-radius:4px}
.leyenda-ejemplos{position:fixed;left:var(--s-4);bottom:var(--s-4);z-index:60;max-width:22rem;margin:0;background:var(--tinta);color:var(--blanco);font-size:.85rem;border-radius:12px;padding:var(--s-3) var(--s-4);box-shadow:var(--sombra)}
.js .aparece{opacity:0;transform:translateY(18px);transition:opacity .6s ease,transform .6s ease}
.js .aparece.visto{opacity:1;transform:none}
.rejilla>.aparece:nth-child(2){transition-delay:.08s}.rejilla>.aparece:nth-child(3){transition-delay:.16s}.rejilla>.aparece:nth-child(4){transition-delay:.24s}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}.js .aparece{opacity:1;transform:none}}
</style>
</head>
<body>
<svg aria-hidden="true" style="display:none">
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-herramienta" viewBox="0 0 24 24"><path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-.5-.5-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-reloj" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-escudo" viewBox="0 0 24 24"><path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-casa" viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5V20h-5v-5H9v5H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-telefono" viewBox="0 0 24 24"><path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-estrella" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/></symbol>
<symbol id="i-mapa" viewBox="0 0 24 24"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/></symbol>
</svg>
<a class="saltar" href="#contenido">Saltar al contenido</a>
<header class="cabecera"><div class="contenedor">
  <a class="marca" href="{{pagina.inicio}}">{{nombre}}</a>
  <nav class="menu" id="menu" aria-label="Principal">{{#menu}}<a href="{{href}}"{{#actual}} aria-current="page"{{/actual}}>{{titulo}}</a>{{/menu}}</nav>
  <button class="abrir-menu" type="button" aria-expanded="false" aria-controls="menu" aria-label="Abrir el menú"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
  {{#telefono_href}}<a class="boton" href="tel:{{telefono_href}}"><svg aria-hidden="true"><use href="#i-telefono"></use></svg><span>Llamar</span></a>{{/telefono_href}}
</div></header>
<main id="contenido">
{{{secciones}}}
</main>
<footer class="pie"><div class="contenedor">
  <p><strong>{{nombre}}</strong>{{#direccion}} · {{direccion}}{{/direccion}}{{#telefono}} · <a href="tel:{{telefono_href}}">{{telefono}}</a>{{/telefono}}</p>
  <p>© {{anio}} {{nombre}}</p>
</div></footer>
<script>
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  var boton = document.querySelector(".abrir-menu");
  var menu = document.getElementById("menu");
  if (boton && menu) {
    boton.addEventListener("click", function () {
      var abierto = menu.classList.toggle("abierto");
      boton.setAttribute("aria-expanded", abierto ? "true" : "false");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") { menu.classList.remove("abierto"); boton.setAttribute("aria-expanded", "false"); }
    });
  }
  var cabecera = document.querySelector(".cabecera");
  window.addEventListener("scroll", function () { cabecera.classList.toggle("con-sombra", window.scrollY > 8); }, { passive: true });
  var elementos = document.querySelectorAll(".aparece");
  if (!("IntersectionObserver" in window)) { elementos.forEach(function (el) { el.classList.add("visto"); }); return; }
  var obs = new IntersectionObserver(function (entradas) {
    entradas.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("visto"); obs.unobserve(en.target); } });
  }, { rootMargin: "0px 0px -10% 0px" });
  elementos.forEach(function (el) { obs.observe(el); });
})();
</script>
</body>
</html>`;

const SECCIONES: SiteTemplateSource['secciones'] = {
  portada: `<section class="portada" id="{{ancla}}"><div class="contenedor">
  <div>
    {{#horario_resumen}}<span class="rotulo">{{horario_resumen}}</span>{{/horario_resumen}}
    <h1>{{titular}}</h1>
    {{#subtitulo}}<p class="lead">{{subtitulo}}</p>{{/subtitulo}}
    <div class="acciones">
      {{#telefono_href}}<a class="boton" href="tel:{{telefono_href}}"><svg aria-hidden="true"><use href="#i-telefono"></use></svg>{{#llamada_accion}}{{llamada_accion}}{{/llamada_accion}}{{^llamada_accion}}Llamar ahora{{/llamada_accion}}</a>{{/telefono_href}}
      <a class="boton boton--claro" href="#contacto">Escribirnos</a>
    </div>
  </div>
  {{#fotos.portada}}<figure class="foto"><img src="{{fotos.portada}}" alt="Trabajo de {{nombre}}">{{#valoracion}}<span class="valoracion"><svg width="16" height="16" aria-hidden="true" style="color:#e0a100"><use href="#i-estrella"></use></svg> {{valoracion}} en Google{{#num_resenas}} · {{num_resenas}} reseñas{{/num_resenas}}</span>{{/valoracion}}</figure>{{/fotos.portada}}
</div></section>`,
  cifras: `<section class="banda" id="{{ancla}}" aria-label="Datos destacados"><div class="contenedor rejilla">
  {{#cifras}}<div class="aparece"><span class="cifra">{{valor}}</span>{{etiqueta}}</div>{{/cifras}}
</div></section>`,
  servicios: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Servicios</span>
  <h2>Lo que hacemos</h2>
  <div class="rejilla">
    {{#servicios}}<article class="tarjeta aparece"><span class="icono"><svg aria-hidden="true"><use href="#i-{{#icono}}{{icono}}{{/icono}}{{^icono}}check{{/icono}}"></use></svg></span><h3>{{nombre}}</h3>{{#descripcion}}<p>{{descripcion}}</p>{{/descripcion}}</article>{{/servicios}}
  </div>
</div></section>`,
  sobre: `<section class="seccion seccion--alt" id="{{ancla}}"><div class="contenedor partida">
  {{#fotos.equipo}}<img class="aparece" src="{{fotos.equipo}}" alt="El equipo de {{nombre}}">{{/fotos.equipo}}
  <div><span class="rotulo">Quiénes somos</span><h2>{{nombre}}</h2><div class="lead">{{{sobre_html}}}</div></div>
</div></section>`,
  proceso: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Cómo trabajamos</span>
  <h2>Del aviso al trabajo terminado</h2>
  <ol class="pasos">{{#proceso}}<li class="aparece"><h3>{{titulo}}</h3>{{#texto}}<p>{{texto}}</p>{{/texto}}</li>{{/proceso}}</ol>
</div></section>`,
  garantias: `<section class="seccion seccion--alt" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Garantías</span>
  <h2>Trabajo con tranquilidad</h2>
  <div class="rejilla">{{#garantias}}<article class="tarjeta aparece"><span class="icono"><svg aria-hidden="true"><use href="#i-escudo"></use></svg></span><h3>{{titulo}}</h3>{{#texto}}<p>{{texto}}</p>{{/texto}}</article>{{/garantias}}</div>
</div></section>`,
  precios: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Precios</span>
  <h2>Precios orientativos</h2>
  <div class="rejilla">{{#precios.filas}}<article class="tarjeta aparece"><h3>{{concepto}}</h3>{{#detalle}}<p>{{detalle}}</p>{{/detalle}}<p class="precio">{{precio}}</p></article>{{/precios.filas}}</div>
  {{#precios.nota}}<p class="nota">{{precios.nota}}</p>{{/precios.nota}}
</div></section>`,
  opiniones: `<section class="seccion seccion--alt" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Opiniones</span>
  <h2>Lo que dicen sus clientes</h2>
  {{#valoracion}}<p class="lead"><strong>{{valoracion}}</strong> en Google{{#num_resenas}}, con {{num_resenas}} reseñas{{/num_resenas}}{{#maps_url}} · <a href="{{maps_url}}">Ver en Google Maps</a>{{/maps_url}}</p>{{/valoracion}}
  {{#citas_html}}<ul class="rejilla citas">{{{citas_html}}}</ul>{{/citas_html}}
  {{#resenas_html}}<div class="rejilla resenas">{{{resenas_html}}}</div>{{{atribucion_google_html}}}{{/resenas_html}}
</div></section>`,
  faq: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Preguntas frecuentes</span>
  <h2>Antes de llamar</h2>
  <div class="preguntas">{{#faq}}<details class="aparece"><summary>{{pregunta}}</summary>{{{respuesta_html}}}</details>{{/faq}}</div>
</div></section>`,
  zona: `<section class="seccion seccion--alt" id="{{ancla}}"><div class="contenedor">
  <span class="rotulo">Zona</span>
  <h2>Dónde trabajamos</h2>
  {{#zona.texto}}<p class="lead">{{zona.texto}}</p>{{/zona.texto}}
  {{#zona.lugares.length}}<ul class="chips">{{#zona.lugares}}<li>{{nombre}}</li>{{/zona.lugares}}</ul>{{/zona.lugares.length}}
</div></section>`,
  llamada: `<section class="llamada" id="{{ancla}}"><div class="contenedor">
  <h2>{{#llamada_accion}}{{llamada_accion}}{{/llamada_accion}}{{^llamada_accion}}¿Hablamos?{{/llamada_accion}}</h2>
  {{#telefono_href}}<a class="telefono" href="tel:{{telefono_href}}">{{telefono}}</a>{{/telefono_href}}
</div></section>`,
  contacto: `<section class="seccion" id="{{ancla}}"><div class="contenedor contacto">
  <div>
    <span class="rotulo">Contacto</span>
    <h2>Cuéntenos qué necesita</h2>
    {{#telefono}}<p><a href="tel:{{telefono_href}}"><strong>{{telefono}}</strong></a></p>{{/telefono}}
    {{#direccion}}<p>{{direccion}}{{#maps_url}} · <a href="{{maps_url}}">Cómo llegar</a>{{/maps_url}}</p>{{/direccion}}
    {{#horario.length}}<table><caption class="saltar">Horario</caption><tbody>{{#horario}}<tr><th scope="row">{{dias}}</th><td>{{horas}}</td></tr>{{/horario}}</tbody></table>{{/horario.length}}
  </div>
  <form id="kairikos-form" class="tarjeta" method="post">
    <label for="kf-name">Nombre</label>
    <input id="kf-name" name="name" maxlength="200" autocomplete="name">
    <label for="kf-contact">Teléfono o email</label>
    <input id="kf-contact" name="contact" maxlength="200" required>
    <label for="kf-message">¿Qué necesita?</label>
    <textarea id="kf-message" name="message" rows="4" maxlength="2000"></textarea>
    <button class="boton" type="submit"{{#formulario.muestra}} disabled{{/formulario.muestra}}>Enviar</button>
    {{#formulario.muestra}}<p class="nota">Formulario de muestra: en la web publicada, los mensajes le llegan al correo.</p>{{/formulario.muestra}}
    <p class="nota" id="kairikos-form-note" hidden></p>
  </form>
</div></section>`,
  bloque_texto: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  {{#titulo}}<h2>{{titulo}}</h2>{{/titulo}}
  <div class="lead">{{{texto_html}}}</div>
</div></section>`,
  bloque_texto_foto: `<section class="seccion" id="{{ancla}}"><div class="contenedor partida">
  {{#foto}}<img class="aparece" src="{{foto}}" alt="{{fotoAlt}}">{{/foto}}
  <div>{{#titulo}}<h2>{{titulo}}</h2>{{/titulo}}<div class="lead">{{{texto_html}}}</div></div>
</div></section>`,
  bloque_lista: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  {{#titulo}}<h2>{{titulo}}</h2>{{/titulo}}
  {{#texto_html}}<div class="lead">{{{texto_html}}}</div>{{/texto_html}}
  <ul class="lista-iconos">{{#items}}<li><svg aria-hidden="true"><use href="#i-{{#icono}}{{icono}}{{/icono}}{{^icono}}check{{/icono}}"></use></svg><span>{{texto}}</span></li>{{/items}}</ul>
</div></section>`,
  bloque_aviso: `<section class="seccion" id="{{ancla}}"><div class="contenedor">
  <div class="aviso" role="note">{{#titulo}}<strong>{{titulo}}</strong> {{/titulo}}{{{texto_html}}}</div>
</div></section>`,
};

export const SITE_TEMPLATE_BASE: SiteTemplateSource = { marco: MARCO, secciones: SECCIONES };
