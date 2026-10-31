import type { SiteSectionType } from './site-content';

// =============================================================================
// Variantes de sección (30/10/2026) — la versión del MOTOR de cada variante
// de site-section-variants.ts: la que sale cuando la plantilla no trae la
// suya (la pieza `servicios@indice`).
//
// Son piezas de Mustache, como las de una plantilla, y se pintan por el mismo
// camino (renderSections): así las marcas de ejemplo, la edición en la vista
// del editor y el título propio del cliente (data-k-titulo-seccion) funcionan
// igual que en una pieza de la plantilla, sin código aparte.
//
// El aspecto, como el de los bloques ricos (site-rich-blocks.ts):
// - se inyecta ANTES del <style> de la plantilla, que gana si retoca algo;
// - toma colores, esquinas y ancho de las variables --k-* que toda plantilla
//   declara (BLOQUES_VARIABLES), y por eso sigue el acento del negocio;
// - la letra de los titulares, de la variable que la plantilla nombra en su
//   estilo (tipografias.titulares, site-style.ts). Si no la nombra no se
//   toca: los <h1>–<h3> ya llevan la de la plantilla, y los números grandes
//   heredan la del texto (variantesCss).
//
// Lo que se aprendió en las plantillas a mano y vale aquí también:
// - Sin JavaScript todo se ve (el laboratorio mide sin él): las pestañas son
//   paneles uno debajo de otro, el carrusel se desplaza con el dedo y el
//   detalle de cada precio está debajo del concepto. El script solo mejora.
// - Una rejilla con tarjetas no lleva align-items:start (el laboratorio pide
//   la misma altura en cada fila); las listas que se abren (acordeón, muro)
//   van en columnas CSS, no en rejilla.
// - Los iconos solo pueden ser los que toda plantilla trae en su sprite
//   (i-check, i-telefono, i-estrella) o el del servicio; el resto se dibuja
//   aquí mismo.
//
// Lo que se dejó fuera a propósito: las fotos y los precios por servicio que
// tenía la página de muestra (S1, S2) no existen en el esquema; las filas
// llevan el icono del servicio. Con una sola foto (lo habitual: no hay más
// que la de portada), el abanico de P3 es una foto sola.
// =============================================================================

const STARS = `<span class="kv-estrellas" aria-hidden="true">${'<svg><use href="#i-estrella"></use></svg>'.repeat(5)}</span>`;
const ICONO = '<svg aria-hidden="true"><use href="#i-{{#icono}}{{icono}}{{/icono}}{{^icono}}check{{/icono}}"></use></svg>';
const FLECHA = '<svg class="kv-flecha" aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ESCUDO = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ACCIONES =
  '<div class="kv-acciones">{{#telefono_href}}<a class="kv-boton" href="tel:{{telefono_href}}"><svg aria-hidden="true"><use href="#i-telefono"></use></svg>Llamar ahora</a>{{/telefono_href}}<a class="kv-boton kv-boton--claro" href="#contacto">Pedir presupuesto</a></div>';
const NOTA_GOOGLE = `{{#valoracion}}<p class="kv-nota-google"><strong>{{valoracion}}</strong>${STARS}<span>en Google{{#num_resenas}} · {{num_resenas}} reseñas{{/num_resenas}}</span></p>{{/valoracion}}`;
const FOTO_PORTADA = '{{#fotos.portada}}<img src="{{fotos.portada}}" alt="Trabajo de {{nombre}}">{{/fotos.portada}}{{^fotos.portada}}<div class="kv-foto-vacia" aria-hidden="true"></div>{{/fotos.portada}}';
const RESENAS = '{{#resenas_html}}<div class="kv-resenas">{{{resenas_html}}}</div>{{{atribucion_google_html}}}{{/resenas_html}}';
const TITULO = '<h2 data-k-titulo-seccion>{{{kv_titulo}}}</h2>';

const open = (tipo: string, v: string, extra = '') => `<section class="kv kv-${tipo} kv-${tipo}--${v}${extra}" id="{{ancla}}">`;

/** Las piezas del motor, por sección y variante. */
export const VARIANT_SOURCES: Partial<Record<SiteSectionType, Record<string, string>>> = {
  portada: {
    panoramica:
      open('portada', 'panoramica') +
      `<div class="kv-dentro"><h1 class="kv-titular">{{titular}}</h1><div class="kv-fila">{{#subtitulo}}<p class="kv-entradilla">{{subtitulo}}</p>{{/subtitulo}}${ACCIONES}</div></div>` +
      `<div class="kv-panoramica-foto">${FOTO_PORTADA}</div>` +
      '<ul class="kv-datos">{{#valoracion}}<li><strong>{{valoracion}}</strong><span>en Google{{#num_resenas}} · {{num_resenas}} reseñas{{/num_resenas}}</span></li>{{/valoracion}}{{#horario_resumen}}<li><strong>Horario</strong><span>{{horario_resumen}}</span></li>{{/horario_resumen}}{{#telefono}}<li><strong>Teléfono</strong><a href="tel:{{telefono_href}}">{{telefono}}</a></li>{{/telefono}}</ul>' +
      '</section>',
    sangre:
      open('portada', 'sangre') +
      '{{#fotos.portada}}<img class="kv-sangre-fondo" src="{{fotos.portada}}" alt="Trabajo de {{nombre}}">{{/fotos.portada}}' +
      `<div class="kv-dentro"><div class="kv-tarjeta">${NOTA_GOOGLE}<h1 class="kv-titular">{{titular}}</h1>{{#subtitulo}}<p class="kv-entradilla">{{subtitulo}}</p>{{/subtitulo}}${ACCIONES}{{#horario_resumen}}<p class="kv-suave">{{horario_resumen}}</p>{{/horario_resumen}}</div></div>` +
      '</section>',
    centrada:
      open('portada', 'centrada') +
      `<div class="kv-dentro">${NOTA_GOOGLE}<h1 class="kv-titular">{{titular}}</h1>{{#subtitulo}}<p class="kv-entradilla">{{subtitulo}}</p>{{/subtitulo}}${ACCIONES}{{#horario_resumen}}<p class="kv-suave">{{horario_resumen}}</p>{{/horario_resumen}}` +
      '<div class="kv-abanico">{{#kv_fotos}}<img src="{{src}}" alt="Trabajo de {{nombre}}">{{/kv_fotos}}{{^kv_fotos}}<div class="kv-foto-vacia" aria-hidden="true"></div>{{/kv_fotos}}</div></div>' +
      '</section>',
    // P4: el mismo formulario que el de contacto (mismos campos y límites,
    // mismo buzón, misma nota de muestra en el borrador), marcado con
    // data-kairikos-form para que el motor lo envíe también (formScript). Las
    // garantías hacen de lista de motivos: es lo único del contenido escrito
    // para eso, y sin ellas la columna queda en titular y teléfono.
    formulario:
      open('portada', 'formulario') +
      `<div class="kv-dentro kv-formulario-caja"><div class="kv-formulario-texto">${NOTA_GOOGLE}<h1 class="kv-titular">{{titular}}</h1>{{#subtitulo}}<p class="kv-entradilla">{{subtitulo}}</p>{{/subtitulo}}` +
      '{{#garantias.length}}<ul class="kv-checks">{{#garantias}}<li><span class="kv-marca"><svg aria-hidden="true"><use href="#i-check"></use></svg></span><span>{{titulo}}</span></li>{{/garantias}}</ul>{{/garantias.length}}' +
      '{{#telefono_href}}<p class="kv-o-llame">O llame al <a href="tel:{{telefono_href}}">{{telefono}}</a>{{#horario_resumen}}<span> · {{horario_resumen}}</span>{{/horario_resumen}}</p>{{/telefono_href}}</div>' +
      '<div class="kv-formulario-lado">{{#fotos.portada}}<img class="kv-formulario-fondo" src="{{fotos.portada}}" alt="">{{/fotos.portada}}' +
      '<form class="kv-formulario" method="post" data-kairikos-form><h2>Pida presupuesto</h2><p class="kv-form-intro">Cuéntenos qué necesita y le respondemos enseguida.</p>' +
      '<label for="kv-p4-nombre">Nombre</label><input id="kv-p4-nombre" name="name" maxlength="200" autocomplete="name">' +
      '<label for="kv-p4-contacto">Teléfono o email</label><input id="kv-p4-contacto" name="contact" maxlength="200" required>' +
      '<label for="kv-p4-mensaje">¿Qué necesita?</label><textarea id="kv-p4-mensaje" name="message" rows="3" maxlength="2000"></textarea>' +
      '<button class="kv-boton" type="submit"{{#formulario.muestra}} disabled{{/formulario.muestra}}>Pedir presupuesto</button>' +
      '{{#formulario.muestra}}<p class="kv-form-nota">Formulario de muestra: en la web publicada, los mensajes le llegan al correo.</p>{{/formulario.muestra}}' +
      '<p class="kv-form-nota" data-kairikos-form-note hidden></p></form></div></div></section>',
  },
  servicios: {
    zigzag:
      open('servicios', 'zigzag') +
      `<div class="kv-dentro">${TITULO}<ol class="kv-zigzag">{{#servicios}}<li><div class="kv-zigzag-icono">${ICONO}</div><div class="kv-zigzag-texto"><span class="kv-num" aria-hidden="true"></span><h3>{{nombre}}</h3>{{#descripcion}}<p>{{descripcion}}</p>{{/descripcion}}</div></li>{{/servicios}}</ol></div></section>`,
    pestanas:
      open('servicios', 'pestanas') +
      `<div class="kv-dentro">${TITULO}<div class="kv-pestanas" data-kv-pestanas>{{#servicios}}<article class="kv-panel"><span class="kv-panel-icono">${ICONO}</span><h3 class="kv-panel-titulo">{{nombre}}</h3>{{#descripcion}}<p>{{descripcion}}</p>{{/descripcion}}</article>{{/servicios}}</div></div></section>`,
    indice:
      open('servicios', 'indice') +
      `<div class="kv-dentro kv-partida"><div class="kv-lado">${TITULO}{{#telefono_href}}<p><a class="kv-boton kv-boton--claro" href="tel:{{telefono_href}}"><svg aria-hidden="true"><use href="#i-telefono"></use></svg>{{telefono}}</a></p>{{/telefono_href}}</div>` +
      `<ol class="kv-indice">{{#servicios}}<li><span class="kv-num" aria-hidden="true"></span><div><h3>{{nombre}}</h3>{{#descripcion}}<p>{{descripcion}}</p>{{/descripcion}}</div>${FLECHA}</li>{{/servicios}}</ol></div></section>`,
    mosaico:
      open('servicios', 'mosaico') +
      `<div class="kv-dentro">${TITULO}<ul class="kv-mosaico">{{#servicios}}<li>${ICONO}<h3>{{nombre}}</h3>{{#descripcion}}<p>{{descripcion}}</p>{{/descripcion}}</li>{{/servicios}}</ul></div></section>`,
  },
  sobre: {
    cita:
      open('sobre', 'cita') +
      `<div class="kv-dentro">{{#kv_foto_sobre}}<img class="kv-cita-foto" src="{{kv_foto_sobre}}" alt="{{nombre}}">{{/kv_foto_sobre}}${TITULO}<div class="kv-cita-texto">{{{sobre_html}}}</div></div></section>`,
    media:
      open('sobre', 'media') +
      `<div class="kv-media-foto">{{#kv_foto_sobre}}<img src="{{kv_foto_sobre}}" alt="{{nombre}}">{{/kv_foto_sobre}}{{^kv_foto_sobre}}<div class="kv-foto-vacia" aria-hidden="true"></div>{{/kv_foto_sobre}}</div>` +
      `<div class="kv-media-texto">${TITULO}<div class="kv-prosa">{{{sobre_html}}}</div>{{#cifras.length}}<ul class="kv-cifras">{{#cifras}}<li><strong>{{valor}}</strong>{{#etiqueta}}<span>{{etiqueta}}</span>{{/etiqueta}}</li>{{/cifras}}</ul>{{/cifras.length}}</div></section>`,
    revista:
      open('sobre', 'revista') +
      `<div class="kv-dentro"><div class="kv-revista-cabeza">${TITULO}{{#direccion}}<p>{{direccion}}</p>{{/direccion}}</div><div class="kv-revista-columnas">{{{sobre_html}}}</div></div></section>`,
  },
  proceso: {
    linea:
      open('proceso', 'linea') +
      `<div class="kv-dentro kv-partida"><div class="kv-lado">${TITULO}</div><ol class="kv-linea">{{#proceso}}<li><h3>{{titulo}}</h3>{{#texto}}<p>{{texto}}</p>{{/texto}}</li>{{/proceso}}</ol></div></section>`,
  },
  garantias: {
    marcas:
      open('garantias', 'marcas') +
      `<div class="kv-dentro">${TITULO}<ul class="kv-marcas">{{#garantias}}<li><span class="kv-marca"><svg aria-hidden="true"><use href="#i-check"></use></svg></span><div><h3>{{titulo}}</h3>{{#texto}}<p>{{texto}}</p>{{/texto}}</div></li>{{/garantias}}</ul></div></section>`,
    iconos:
      open('garantias', 'iconos') +
      `<div class="kv-dentro">${TITULO}<ul class="kv-iconos">{{#garantias}}<li><span class="kv-icono-grande">${ESCUDO}</span><h3>{{titulo}}</h3>{{#texto}}<p>{{texto}}</p>{{/texto}}</li>{{/garantias}}</ul></div></section>`,
  },
  precios: {
    ventanitas:
      open('precios', 'ventanitas') +
      `<div class="kv-dentro kv-partida"><div class="kv-lado">${TITULO}{{#precios.nota}}<p class="kv-suave">{{precios.nota}}</p>{{/precios.nota}}{{#telefono_href}}<p><a class="kv-boton" href="tel:{{telefono_href}}"><svg aria-hidden="true"><use href="#i-telefono"></use></svg>Pedir presupuesto</a></p>{{/telefono_href}}</div>` +
      '<div class="kv-tabla">{{#precios.filas}}<div class="kv-fila-precio"><div class="kv-concepto"><span>{{concepto}}</span>{{#detalle}}<span class="kv-detalle">{{detalle}}</span>{{/detalle}}</div><strong>{{precio}}</strong></div>{{/precios.filas}}</div></div></section>',
  },
  opiniones: {
    carrusel:
      open('opiniones', 'carrusel', ' kv-oscura') +
      `<div class="kv-dentro" data-kv-carrusel><div class="kv-cabeza">${TITULO}${NOTA_GOOGLE}</div>` +
      '{{#citas_html}}<ul class="kv-pista">{{{citas_html}}}</ul>{{/citas_html}}{{#resenas_html}}<div class="kv-pista">{{{resenas_html}}}</div>{{{atribucion_google_html}}}{{/resenas_html}}</div></section>',
    muro:
      open('opiniones', 'muro') +
      `<div class="kv-dentro">${TITULO}<ul class="kv-muro">{{#valoracion}}<li class="kv-muro-nota"><strong>{{valoracion}}</strong>${STARS}<span>de media en Google{{#num_resenas}}, con {{num_resenas}} reseñas{{/num_resenas}}</span>{{#maps_url}}<a href="{{maps_url}}">Leerlas en Google Maps</a>{{/maps_url}}</li>{{/valoracion}}{{{citas_html}}}</ul>` +
      '{{#resenas_html}}<div class="kv-muro">{{{resenas_html}}}</div>{{{atribucion_google_html}}}{{/resenas_html}}</div></section>',
    destacada:
      open('opiniones', 'destacada') +
      `<div class="kv-dentro kv-partida"><div class="kv-lado"><div class="kv-lado-tarjeta">${TITULO}{{#valoracion}}<p class="kv-nota-grande"><strong>{{valoracion}}</strong>${STARS}</p><p class="kv-suave">de media en Google{{#num_resenas}}, con {{num_resenas}} reseñas{{/num_resenas}}</p>{{#maps_url}}<p><a href="{{maps_url}}">Leerlas en Google Maps</a></p>{{/maps_url}}{{/valoracion}}</div></div>` +
      `<div class="kv-destacada-lista">{{#citas_html}}<ul class="kv-citas">{{{citas_html}}}</ul>{{/citas_html}}${RESENAS}</div></div></section>`,
  },
  faq: {
    'dos-columnas':
      open('faq', 'dos-columnas') +
      `<div class="kv-dentro">${TITULO}<div class="kv-acordeon">{{#faq}}<details><summary>{{pregunta}}</summary><div class="kv-respuesta">{{{respuesta_html}}}</div></details>{{/faq}}</div></div></section>`,
    panel:
      open('faq', 'panel') +
      `<div class="kv-dentro">${TITULO}<div class="kv-pestanas kv-pestanas--preguntas" data-kv-pestanas>{{#faq}}<article class="kv-panel"><h3 class="kv-panel-titulo">{{pregunta}}</h3><div class="kv-respuesta">{{{respuesta_html}}}</div></article>{{/faq}}</div>` +
      '{{#telefono_href}}<p class="kv-ayuda">¿No está su pregunta? <a href="tel:{{telefono_href}}">Llame al {{telefono}}</a></p>{{/telefono_href}}</div></section>',
  },
};

/** El título por defecto de una variante cuando la plantilla no marca el
 *  suyo (las de antes del 29/10 no lo marcaban). */
export const VARIANT_DEFAULT_TITLES: Partial<Record<SiteSectionType, string>> = {
  servicios: 'Servicios',
  sobre: 'Quiénes somos',
  proceso: 'Cómo trabajamos',
  garantias: 'Nuestras garantías',
  precios: 'Precios',
  opiniones: 'Lo que dicen nuestros clientes',
  faq: 'Preguntas frecuentes',
};

const CSS = `
.kv{padding-block:clamp(3rem,7vw,5.5rem);overflow-wrap:anywhere}
.kv-dentro{width:min(100% - 2*var(--k-margen,1.5rem),var(--k-ancho,1200px));margin-inline:auto}
.kv h2{margin-top:0}
.kv h3{margin:0 0 .35rem}
.kv p{margin:0 0 .9rem}
.kv img{display:block;max-width:100%}
.kv svg{width:1.25rem;height:1.25rem;flex:none}
.kv-suave{color:var(--k-suave,inherit)}
.kv-foto-vacia{width:100%;height:100%;min-height:14rem;border-radius:var(--k-radio,8px);background:repeating-linear-gradient(135deg,var(--k-borde,rgba(127,127,127,.25)) 0 1px,transparent 1px 14px),var(--k-superficie,#f3f3f3)}
.kv-acciones{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0 0}
.kv-boton{display:inline-flex;align-items:center;gap:.55rem;min-height:3rem;padding:.75rem 1.35rem;border-radius:var(--k-radio,8px);border:2px solid var(--k-acento,#222);background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff);font-weight:700;text-decoration:none;line-height:1.2;transition:transform .2s ease,box-shadow .2s ease}
.kv-boton:hover{transform:translateY(-2px);box-shadow:0 10px 24px -14px rgba(0,0,0,.5)}
.kv-boton--claro{background:transparent;color:inherit;border-color:currentColor}
.kv-num::before{content:counter(kv-n,decimal-leading-zero)}
.kv-estrellas{display:inline-flex;gap:.12rem;color:var(--k-acento-texto,var(--k-acento,currentColor))}
.kv-estrellas svg{width:1rem;height:1rem;fill:currentColor}
.kv-nota-google{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;margin:0 0 1.25rem}
.kv-nota-google strong{font-size:1.15rem}
.kv-partida{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:2.5rem 5rem;align-items:start}
.kv-lado{position:sticky;top:6rem}
/* En la columna estrecha, el título de la plantilla a tamaño de columna: con
   una letra ancha (la Syne de «Bloque») partía «climatización» a 1100 px. */
@media (min-width:861px){.kv-lado h2{font-size:clamp(1.6rem,1rem + 1.6vw,2.4rem)}}
@media (max-width:860px){.kv-partida{grid-template-columns:minmax(0,1fr)}.kv-lado{position:static}}

/* P1 */
.kv-portada--panoramica{padding-bottom:clamp(1.5rem,4vw,2.5rem)}
.kv-portada--panoramica .kv-titular{font-size:clamp(2.1rem,.9rem + 5vw,5.6rem);line-height:1;letter-spacing:-.025em;max-width:17ch;margin:0 0 1.75rem}
.kv-portada--panoramica .kv-fila{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:1rem 3rem;margin-bottom:2.5rem}
.kv-portada--panoramica .kv-entradilla{max-width:46ch;font-size:1.15rem;margin:0}
.kv-portada--panoramica .kv-acciones{margin:0}
.kv-panoramica-foto img,.kv-panoramica-foto .kv-foto-vacia{width:100%;aspect-ratio:21/8;min-height:15rem;object-fit:cover;border-radius:0}
.kv-datos{position:relative;list-style:none;margin:-2.75rem auto 0;padding:0;width:min(100% - 2rem,56rem);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.25));border-radius:var(--k-radio,8px);box-shadow:var(--k-sombra,0 22px 40px -24px rgba(0,0,0,.35))}
.kv-datos:empty{display:none}
.kv-datos li{padding:1rem 1.25rem;text-align:center;display:flex;flex-direction:column;gap:.15rem;color:var(--k-suave,inherit)}
.kv-datos li+li{border-left:1px solid var(--k-borde,rgba(127,127,127,.25))}
.kv-datos strong{font-size:1.35rem;line-height:1.15;color:var(--k-acento-texto,inherit)}
.kv-datos a{color:inherit;font-weight:600}
@media (max-width:640px){.kv-datos{margin-top:-1.5rem}.kv-datos li{padding:.75rem 1rem}.kv-datos li+li{border-left:0;border-top:1px solid var(--k-borde,rgba(127,127,127,.25))}}

/* P2 */
.kv-portada--sangre{position:relative;isolation:isolate;min-height:min(42rem,90vh);display:flex;align-items:flex-end;padding-top:clamp(8rem,22vw,14rem)}
.kv-sangre-fondo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1}
.kv-portada--sangre:not(:has(.kv-sangre-fondo)){background:var(--k-acento,#333)}
.kv-tarjeta{max-width:36rem;background:var(--k-superficie,#fff);border-radius:var(--k-radio,8px);padding:clamp(1.5rem,4vw,2.5rem);box-shadow:var(--k-sombra,0 30px 60px -30px rgba(0,0,0,.55))}
.kv-tarjeta .kv-titular{font-size:clamp(1.9rem,1.1rem + 2.6vw,3.2rem);line-height:1.05;margin:0 0 1rem}
.kv-tarjeta .kv-suave{margin:1rem 0 0;font-size:.95rem}

/* P3 */
.kv-portada--centrada{text-align:center;overflow:hidden}
.kv-portada--centrada .kv-titular{font-size:clamp(2rem,.9rem + 4vw,4.6rem);line-height:1.03;letter-spacing:-.02em;max-width:19ch;margin:0 auto 1.25rem}
.kv-portada--centrada .kv-entradilla{max-width:50ch;margin:0 auto;font-size:1.15rem}
.kv-portada--centrada .kv-acciones{justify-content:center}
.kv-portada--centrada .kv-suave{margin:1rem 0 0}
.kv-abanico{display:flex;justify-content:center;align-items:flex-end;margin-top:3rem;padding-inline:1rem}
.kv-abanico img,.kv-abanico .kv-foto-vacia{width:min(32%,20rem);aspect-ratio:3/4;object-fit:cover;border-radius:var(--k-radio,8px);border:6px solid var(--k-superficie,#fff);box-shadow:0 20px 40px -20px rgba(0,0,0,.4);transition:transform .4s ease}
.kv-abanico>:only-child{width:min(100%,64rem);aspect-ratio:16/8;min-height:13rem}
.kv-abanico>:nth-child(1):not(:only-child){transform:rotate(-6deg) translate(16%,6%)}
.kv-abanico>:nth-child(2){position:relative;z-index:1;width:min(38%,23rem)}
.kv-abanico>:nth-child(3){transform:rotate(6deg) translate(-16%,6%)}

/* P4 */
.kv-formulario-caja{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:2.5rem clamp(2rem,5vw,4.5rem);align-items:center}
.kv-portada--formulario .kv-titular{font-size:clamp(2rem,1.1rem + 3vw,3.8rem);line-height:1.04;margin:0 0 1.25rem}
.kv-portada--formulario .kv-entradilla{font-size:1.12rem;max-width:44ch}
.kv-checks{list-style:none;margin:1.75rem 0 0;padding:0;display:grid;gap:.75rem;font-weight:700}
.kv-checks li{display:flex;gap:.7rem;align-items:center}
.kv-checks .kv-marca{width:1.7rem;height:1.7rem}
.kv-portada--formulario .kv-o-llame{margin:1.75rem 0 0;color:var(--k-suave,inherit)}
.kv-o-llame a{font-weight:700;color:var(--k-acento-texto,inherit)}
.kv-formulario-lado{position:relative;isolation:isolate;overflow:hidden;display:grid;place-items:center;padding:clamp(1.25rem,4vw,2.75rem);border-radius:var(--k-radio,8px);background:var(--k-acento,#333)}
.kv-formulario-fondo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35;z-index:-1}
.kv-formulario{width:100%;max-width:27rem;box-sizing:border-box;padding:clamp(1.25rem,3vw,2rem);border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,0px) solid var(--k-borde,transparent);box-shadow:var(--k-sombra,0 30px 60px -30px rgba(0,0,0,.5))}
.kv-formulario h2{font-size:1.55rem;margin:0 0 .3rem}
.kv-form-intro{margin:0;color:var(--k-suave,inherit)}
.kv-formulario label{display:block;font-weight:700;font-size:.9rem;margin:1rem 0 .35rem}
.kv-formulario input,.kv-formulario textarea{display:block;width:100%;box-sizing:border-box;font:inherit;color:inherit;padding:.75rem .9rem;border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.45));border-radius:var(--k-radio,8px);background:transparent}
.kv-formulario textarea{resize:vertical;min-height:5.5rem}
.kv-formulario input:focus-visible,.kv-formulario textarea:focus-visible{outline:3px solid var(--k-acento,#222);outline-offset:1px}
.kv-formulario .kv-boton{width:100%;justify-content:center;margin-top:1.25rem;cursor:pointer;font:inherit;font-weight:700}
.kv-formulario .kv-boton[disabled]{opacity:.65;cursor:not-allowed;transform:none;box-shadow:none}
.kv-form-nota{margin:.85rem 0 0;font-size:.88rem;color:var(--k-suave,inherit)}
@media (max-width:860px){.kv-formulario-caja{grid-template-columns:minmax(0,1fr)}}

/* S1 */
.kv-zigzag{list-style:none;margin:2.5rem 0 0;padding:0;counter-reset:kv-n;display:flex;flex-direction:column;gap:clamp(1.5rem,3vw,2.25rem)}
.kv-zigzag>li{counter-increment:kv-n;display:flex;align-items:center;gap:1rem clamp(1.25rem,4vw,2.75rem);width:min(100%,48rem)}
.kv-zigzag>li:nth-child(even){margin-left:auto;flex-direction:row-reverse;text-align:right}
.kv-zigzag>li:nth-child(even) p{margin-left:auto}
.kv-zigzag-icono{flex:none;display:grid;place-items:center;width:clamp(5.5rem,13vw,8.5rem);aspect-ratio:1;border-radius:var(--k-radio,8px);background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff);border:var(--k-borde-ancho,0px) solid var(--k-borde,transparent);box-shadow:var(--k-sombra,none);transition:transform .35s ease}
.kv-zigzag-icono svg{width:42%;height:42%}
.kv-zigzag>li:nth-child(odd):hover .kv-zigzag-icono{transform:rotate(-5deg)}
.kv-zigzag>li:nth-child(even):hover .kv-zigzag-icono{transform:rotate(5deg)}
.kv-zigzag-texto{min-width:0;flex:1 1 auto}
.kv-zigzag .kv-num{display:block;font-size:clamp(1.6rem,1.2rem + 1.2vw,2.3rem);line-height:1;font-weight:700;color:var(--k-acento-texto,inherit);margin-bottom:.35rem}
.kv-zigzag p{color:var(--k-suave,inherit);max-width:52ch;margin-bottom:0}
@media (max-width:600px){.kv-zigzag>li,.kv-zigzag>li:nth-child(even){flex-direction:row;text-align:left;margin-left:0;align-items:flex-start}.kv-zigzag>li:nth-child(even) p{margin-left:0}.kv-zigzag-icono{width:4.25rem}}

/* S2 y F2: pestañas a un lado */
.kv-pestanas{margin-top:2.5rem}
.kv-panel{padding:1.5rem;border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2));box-shadow:var(--k-sombra,none)}
.kv-panel+.kv-panel{margin-top:1rem}
.kv-panel-icono{display:inline-grid;place-items:center;width:3.25rem;height:3.25rem;margin-bottom:1rem;border-radius:var(--k-radio,8px);background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.kv-panel-icono svg{width:1.6rem;height:1.6rem}
.kv-panel p,.kv-respuesta{color:var(--k-suave,inherit)}
.kv-respuesta>:last-child{margin-bottom:0}
.kv-pestanas--js{display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);gap:1.5rem 2rem;align-items:start}
.kv-pestanas--js .kv-panel+.kv-panel{margin-top:0}
.kv-pestanas--js .kv-panel{grid-column:2;grid-row:1;padding:clamp(1.5rem,4vw,2.5rem)}
.kv-pestanas--js .kv-panel-titulo{font-size:1.6rem}
.kv-panel[hidden]{display:none}
.kv-pestanas-lista{grid-column:1;grid-row:1;display:flex;flex-direction:column;gap:.3rem}
.kv-pestanas-lista button{display:flex;align-items:center;gap:.7rem;width:100%;text-align:left;font:inherit;font-weight:700;padding:.85rem 1rem;border:0;border-radius:var(--k-radio,8px);background:transparent;color:inherit;cursor:pointer;transition:background .2s ease,color .2s ease}
.kv-pestanas-lista button:hover{background:var(--k-superficie,rgba(127,127,127,.1))}
.kv-pestanas-lista button[aria-selected="true"]{background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.kv-pestanas-lista button:focus-visible{outline:3px solid var(--k-acento,#222);outline-offset:2px}
.kv-pestanas-lista .kv-panel-icono{width:auto;height:auto;margin:0;background:none;color:inherit}
.kv-pestanas-lista .kv-panel-icono svg{width:1.3rem;height:1.3rem}
.kv-pestanas--preguntas .kv-pestanas-lista{gap:0}
.kv-pestanas--preguntas .kv-pestanas-lista button:first-child{border-top:1px solid var(--k-borde,rgba(127,127,127,.3))}
.kv-pestanas--preguntas .kv-pestanas-lista button{border-radius:0;border-bottom:1px solid var(--k-borde,rgba(127,127,127,.3));padding:1rem .5rem}
.kv-pestanas--preguntas .kv-pestanas-lista button[aria-selected="true"]{background:transparent;color:var(--k-acento-texto,inherit)}
.kv-pestanas--preguntas.kv-pestanas--js{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)}
@media (max-width:760px){.kv-pestanas--js,.kv-pestanas--preguntas.kv-pestanas--js{grid-template-columns:minmax(0,1fr)}.kv-pestanas--js .kv-panel{grid-column:1;grid-row:2}}
.kv-ayuda{margin-top:2rem}
.kv-ayuda a{font-weight:700;color:var(--k-acento-texto,inherit)}

/* S3 */
.kv-indice{list-style:none;margin:0;padding:0;counter-reset:kv-n;border-top:2px solid currentColor}
.kv-indice>li{counter-increment:kv-n;display:grid;grid-template-columns:2.75rem minmax(0,1fr) auto;gap:1rem;align-items:baseline;padding:1.35rem .5rem;border-bottom:1px solid var(--k-borde,rgba(127,127,127,.3));transition:background .2s ease,padding .2s ease}
.kv-indice>li:hover{background:var(--k-superficie,rgba(127,127,127,.08));padding-inline:1rem}
.kv-indice .kv-num{font-weight:600;color:var(--k-suave,inherit)}
.kv-indice p{margin:0;color:var(--k-suave,inherit)}
.kv-indice .kv-flecha{color:var(--k-acento-texto,currentColor);transition:transform .2s ease}
.kv-indice>li:hover .kv-flecha{transform:translateX(4px)}

/* S4 */
.kv-mosaico{list-style:none;margin:2.5rem 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
.kv-mosaico>li{display:flex;flex-direction:column;min-height:12rem;padding:1.5rem;border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2));transition:transform .25s ease;box-shadow:var(--k-sombra,none)}
.kv-mosaico>li:hover{transform:translateY(-3px)}
.kv-mosaico>li svg{width:2rem;height:2rem;margin-bottom:auto;padding-bottom:1rem;box-sizing:content-box;color:var(--k-acento-texto,var(--k-acento,currentColor))}
.kv-mosaico>li p{margin:0;font-size:.95rem;color:var(--k-suave,inherit)}
.kv-mosaico>li:first-child{grid-column:span 2;background:var(--k-acento,#222);border-color:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.kv-mosaico>li:first-child h3{font-size:1.7rem}
.kv-mosaico>li:first-child p,.kv-mosaico>li:first-child svg{color:inherit}
@media (max-width:980px){.kv-mosaico{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.kv-mosaico{grid-template-columns:minmax(0,1fr)}.kv-mosaico>li{min-height:0}.kv-mosaico>li:first-child{grid-column:auto}}

/* Q1 */
.kv-sobre--cita{text-align:center}
.kv-sobre--cita .kv-dentro{max-width:52rem}
.kv-cita-foto{width:7.5rem;height:7.5rem;margin:0 auto 1.75rem;border-radius:50%;object-fit:cover;border:5px solid var(--k-superficie,#fff);box-shadow:0 12px 30px -12px rgba(0,0,0,.4)}
.kv-cita-texto>p:first-child{font-size:clamp(1.25rem,1rem + 1vw,1.75rem);line-height:1.4;font-style:italic}
.kv-cita-texto>p:first-child::before{content:"“";display:block;height:.6em;font-size:3.2em;line-height:1;color:var(--k-acento-texto,inherit)}
.kv-cita-texto>:not(:first-child){color:var(--k-suave,inherit);max-width:58ch;margin-inline:auto}
.kv-cita-texto ul,.kv-cita-texto ol{text-align:left}

/* Q2 */
.kv-sobre--media{padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}
.kv-media-foto img,.kv-media-foto .kv-foto-vacia{width:100%;height:100%;min-height:24rem;object-fit:cover;border-radius:0}
.kv-media-texto{padding:clamp(2.5rem,6vw,5rem) clamp(1rem,5vw,5rem);background:var(--k-superficie,transparent)}
.kv-media-texto .kv-prosa{max-width:56ch}
.kv-cifras{list-style:none;margin:2rem 0 0;padding:1.5rem 0 0;border-top:1px solid var(--k-borde,rgba(127,127,127,.3));display:flex;flex-wrap:wrap;gap:1.25rem 2.5rem}
.kv-cifras strong{display:block;font-size:2.1rem;line-height:1;color:var(--k-acento-texto,inherit)}
.kv-cifras li>span{font-size:.9rem;color:var(--k-suave,inherit)}
@media (max-width:820px){.kv-sobre--media{grid-template-columns:minmax(0,1fr)}.kv-media-foto img,.kv-media-foto .kv-foto-vacia{min-height:16rem;aspect-ratio:16/10;height:auto}}

/* Q3 */
.kv-revista-cabeza{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:.5rem 3rem;padding-bottom:1.25rem;margin-bottom:2.25rem;border-bottom:2px solid currentColor}
.kv-revista-cabeza h2{margin:0;max-width:18ch}
.kv-revista-cabeza p{margin:0;font-style:italic;color:var(--k-suave,inherit)}
.kv-revista-columnas{columns:2 20rem;column-gap:3rem;font-size:1.05rem}
.kv-revista-columnas>*{break-inside:avoid-column}
.kv-revista-columnas>p:has(+ul,+ol){break-after:avoid-column}
.kv-revista-columnas>p+:is(ul,ol){break-before:avoid-column}
.kv-revista-columnas>p:first-child::first-letter{float:left;font-size:4.2em;line-height:.8;font-weight:700;margin:.08em .12em 0 0;color:var(--k-acento-texto,inherit)}

/* L2 */
.kv-linea{list-style:none;margin:0;padding:0;counter-reset:kv-n}
.kv-linea>li{counter-increment:kv-n;position:relative;padding:0 0 2.25rem 4.25rem}
.kv-linea>li::before{content:counter(kv-n);position:absolute;left:0;top:0;width:2.9rem;height:2.9rem;border-radius:50%;display:grid;place-items:center;background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff);font-weight:700;font-size:1.15rem}
.kv-linea>li:not(:last-child)::after{content:"";position:absolute;left:calc(1.45rem - 1px);top:3.2rem;bottom:.3rem;border-left:2px dashed var(--k-borde,rgba(127,127,127,.4))}
.kv-linea h3{padding-top:.55rem}
.kv-linea p{margin:0;color:var(--k-suave,inherit)}

/* L1 */
.kv-marcas{list-style:none;margin:2rem 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1.25rem 2.5rem}
.kv-marcas>li{display:flex;gap:.9rem;align-items:flex-start;padding-bottom:1.25rem;border-bottom:1px dashed var(--k-borde,rgba(127,127,127,.4))}
.kv-marca{display:grid;place-items:center;flex:none;width:2rem;height:2rem;border-radius:50%;background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.kv-marca svg{width:1.1rem;height:1.1rem}
.kv-marcas p{margin:0;color:var(--k-suave,inherit)}

/* L3 */
.kv-garantias--iconos{text-align:center}
.kv-iconos{list-style:none;margin:2.5rem 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:2.5rem 2rem}
.kv-icono-grande{display:grid;place-items:center;width:4.75rem;height:4.75rem;margin:0 auto 1rem;border-radius:50%;background:var(--k-superficie,#f3f3f3);border:2px solid var(--k-acento,#222);color:var(--k-acento-texto,var(--k-acento,currentColor));transition:transform .35s ease}
.kv-iconos>li:hover .kv-icono-grande{transform:translateY(-4px) rotate(-6deg)}
.kv-icono-grande svg{width:2.2rem;height:2.2rem}
.kv-iconos p{margin:0 auto;max-width:28ch;color:var(--k-suave,inherit)}

/* L4 */
.kv-tabla{padding:.5rem clamp(1rem,3vw,1.75rem);border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2));box-shadow:var(--k-sombra,none)}
.kv-fila-precio{position:relative;display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--k-borde,rgba(127,127,127,.25))}
.kv-fila-precio:last-child{border-bottom:0}
.kv-fila-precio>strong{flex:none;max-width:45%;text-align:right;color:var(--k-acento-texto,inherit)}
.kv-concepto{min-width:0}
.kv-detalle{display:block;margin-top:.2rem;font-size:.9rem;color:var(--k-suave,inherit)}
.kv-info{display:inline-grid;place-items:center;width:1.5rem;height:1.5rem;margin-left:.4rem;vertical-align:.1em;border:1px solid currentColor;border-radius:50%;background:transparent;color:var(--k-acento-texto,inherit);font:700 .8rem/1 Georgia,serif;font-style:italic;cursor:pointer}
.kv-info[aria-expanded="true"]{background:var(--k-acento,#222);border-color:var(--k-acento,#222);color:var(--k-sobre-acento,#fff)}
.kv-globo{position:absolute;left:0;right:0;top:calc(100% - .4rem);z-index:5;margin:0;padding:.85rem 1rem;border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.3));box-shadow:0 18px 36px -18px rgba(0,0,0,.45);color:inherit;font-size:.92rem}
.kv-globo[hidden]{display:none}

/* O1 */
.kv-oscura{background:#15181d;color:#f4f4f2}
.kv-oscura *,.kv-oscura *::before,.kv-oscura *::after{color:inherit!important}
.kv-oscura .kv-estrellas,.kv-oscura .resena-estrellas{color:#f5c04a!important}
.kv-oscura :is(.cita,.resena){background:rgba(255,255,255,.07)!important;border-color:rgba(255,255,255,.16)!important;box-shadow:none!important}
.kv-cabeza{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:.5rem 2rem;margin-bottom:2rem}
.kv-cabeza h2{margin:0}
.kv-cabeza .kv-nota-google{margin:0}
.kv-pista{list-style:none;margin:0 0 1rem;padding:0 0 1rem;display:grid;grid-auto-flow:column;grid-auto-columns:min(85%,24rem);gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:thin}
.kv-pista>*{scroll-snap-align:start;margin:0;min-width:0}
.kv-carrusel-nav{display:flex;gap:.5rem;justify-content:flex-end}
.kv-carrusel-nav button{display:grid;place-items:center;width:3rem;height:3rem;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;cursor:pointer}
.kv-carrusel-nav button:hover,.kv-carrusel-nav button:focus-visible{background:rgba(255,255,255,.14);outline:none}

/* O2 y O3, sobre el fondo de la página. Las citas y reseñas llevan los
   colores que su plantilla pensó para SU sección de opiniones, y varias la
   tienen oscura (Estudio, Señal, Consulta): sobre fondo claro salía texto
   blanco sobre crema (contraste 1,0 en el laboratorio del 30/10). Aquí van
   como las demás tarjetas del motor: la superficie y el texto de la página. */
.kv-opiniones:not(.kv-oscura) :is(.cita,.resena){background:var(--k-superficie,#fff)!important;border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2))!important}
.kv-opiniones:not(.kv-oscura) :is(.cita,.resena,.atribucion-google),.kv-opiniones:not(.kv-oscura) :is(.cita,.resena,.atribucion-google) *{color:inherit!important}
.kv-opiniones:not(.kv-oscura) :is(.cita-autor,.atribucion-google,.resena figcaption){color:var(--k-suave,inherit)!important}
.kv-opiniones:not(.kv-oscura) .resena-estrellas{color:var(--k-acento-texto,inherit)!important}

/* O2 */
.kv-muro{list-style:none;margin:2.25rem 0 0;padding:0;columns:3 16rem;column-gap:1.25rem}
.kv-muro>*{break-inside:avoid;margin:0 0 1.25rem!important;display:block}
.kv-muro-nota{padding:1.75rem;border-radius:var(--k-radio,8px);background:var(--k-acento,#222);color:var(--k-sobre-acento,#fff);text-align:center}
.kv-muro-nota strong{display:block;font-size:3.6rem;line-height:1}
.kv-muro-nota .kv-estrellas{color:inherit;justify-content:center;margin:.5rem 0}
.kv-muro-nota>span:not(.kv-estrellas),.kv-muro-nota>a{display:block;color:inherit}
.kv-muro-nota a{margin-top:.75rem;font-weight:700}

/* O3 */
.kv-lado-tarjeta{padding:clamp(1.5rem,3vw,2rem);border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2));box-shadow:var(--k-sombra,none)}
.kv-nota-grande{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1rem;margin:1rem 0 .25rem!important}
.kv-nota-grande strong{font-size:clamp(3.2rem,2rem + 3vw,4.6rem);line-height:1;letter-spacing:-.03em}
.kv-lado-tarjeta a{font-weight:700;color:var(--k-acento-texto,inherit)}
.kv-citas,.kv-resenas{list-style:none;margin:0 0 1.5rem;padding:0;display:grid;gap:1rem}
.kv-citas>*,.kv-resenas>*{margin:0}

/* F1 */
.kv-acordeon{columns:2 22rem;column-gap:1.5rem;margin-top:2rem}
.kv-acordeon details{break-inside:avoid;margin:0 0 1rem;padding:0 1.25rem;border-radius:var(--k-radio,8px);background:var(--k-superficie,#fff);border:var(--k-borde-ancho,1px) solid var(--k-borde,rgba(127,127,127,.2));box-shadow:var(--k-sombra,none)}
.kv-acordeon summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;gap:1rem;padding:1.1rem 0;font-weight:700}
.kv-acordeon summary::-webkit-details-marker{display:none}
.kv-acordeon summary::after{content:"+";flex:none;font-size:1.5rem;line-height:1;color:var(--k-acento-texto,inherit);transition:transform .25s ease}
.kv-acordeon details[open] summary::after{transform:rotate(45deg)}
.kv-acordeon .kv-respuesta{padding-bottom:1.1rem}

@media (prefers-reduced-motion:reduce){.kv *,.kv *::before,.kv *::after{transition:none!important}}
`;

/** La hoja de las variantes. `titulares` es la variable de la letra de los
 *  titulares de la plantilla ('--display'), si la declara. */
export function variantesCss(titulares: string | null | undefined): string {
  const familia =
    titulares && /^--[a-z0-9-]+$/i.test(titulares)
      ? `\n.kv .kv-num,.kv-datos strong,.kv-nota-google strong,.kv-nota-grande strong,.kv-muro-nota strong,.kv-cifras strong,.kv-linea>li::before,.kv-cita-texto>p:first-child,.kv-revista-columnas>p:first-child::first-letter,.kv-fila-precio>strong{font-family:var(${titulares})}`
      : '';
  return `<style id="variantes-kairikos">${CSS}${familia}</style>`;
}

/** El comportamiento: pestañas a un lado (S2, F2), los botones del carrusel
 *  (O1) y las ventanitas de los precios (L4). Sin él todo se ve. */
export const VARIANTES_JS = `<script>
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-kv-pestanas]").forEach(function (cont, n) {
    var paneles = Array.prototype.slice.call(cont.children).filter(function (p) { return p.classList.contains("kv-panel"); });
    if (paneles.length < 2) return;
    var lista = document.createElement("div");
    lista.className = "kv-pestanas-lista"; lista.setAttribute("role", "tablist");
    var botones = paneles.map(function (p, i) {
      var b = document.createElement("button");
      var t = p.querySelector(".kv-panel-titulo");
      var ico = p.querySelector(".kv-panel-icono");
      b.type = "button"; p.id = "kv-panel-" + n + "-" + i; b.id = p.id + "-tab";
      if (ico) b.appendChild(ico.cloneNode(true));
      var s = document.createElement("span"); s.textContent = t ? t.textContent : String(i + 1); b.appendChild(s);
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
      var i = botones.indexOf(document.activeElement), j = -1;
      if (i < 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % botones.length;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + botones.length) % botones.length;
      if (e.key === "Home") j = 0;
      if (e.key === "End") j = botones.length - 1;
      if (j >= 0) { e.preventDefault(); elegir(j, true); }
    });
    cont.insertBefore(lista, paneles[0]);
    cont.classList.add("kv-pestanas--js");
    elegir(0, false);
  });
  document.querySelectorAll("[data-kv-carrusel]").forEach(function (c) {
    var pistas = c.querySelectorAll(".kv-pista");
    pistas.forEach(function (pista) {
      if (pista.children.length < 2 || pista.scrollWidth <= pista.clientWidth + 4) return;
      var nav = document.createElement("div");
      nav.className = "kv-carrusel-nav";
      [["Anterior", "M15 6l-6 6 6 6", -1], ["Siguiente", "M9 6l6 6-6 6", 1]].forEach(function (d) {
        var b = document.createElement("button");
        b.type = "button"; b.setAttribute("aria-label", d[0]);
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d[1] + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        b.addEventListener("click", function () { pista.scrollBy({ left: d[2] * pista.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" }); });
        nav.appendChild(b);
      });
      pista.parentNode.insertBefore(nav, pista.nextSibling);
    });
  });
  // En la vista del editor el detalle se queda a la vista: es donde se
  // escribe (k-dato), y escondido no se podría pulsar.
  if (!document.querySelector("k-dato")) {
    var globos = [];
    var cerrar = function () { globos.forEach(function (g) { g[0].hidden = true; g[1].setAttribute("aria-expanded", "false"); }); };
    document.querySelectorAll(".kv-precios--ventanitas .kv-detalle").forEach(function (d, i) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "kv-info"; b.textContent = "i";
      b.setAttribute("aria-label", "Qué incluye"); b.setAttribute("aria-expanded", "false");
      d.id = "kv-detalle-" + i; b.setAttribute("aria-controls", d.id);
      d.classList.add("kv-globo"); d.hidden = true;
      var fila = d.closest(".kv-fila-precio");
      d.previousElementSibling.appendChild(b);
      fila.appendChild(d);
      globos.push([d, b]);
      b.addEventListener("click", function (e) { e.stopPropagation(); var abrir = d.hidden; cerrar(); d.hidden = !abrir; b.setAttribute("aria-expanded", String(abrir)); });
    });
    if (globos.length) {
      document.addEventListener("click", function (e) { if (!(e.target.closest && e.target.closest(".kv-globo"))) cerrar(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") cerrar(); });
    }
  }
})();
</script>`;
