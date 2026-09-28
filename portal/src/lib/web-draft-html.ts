import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// A11, capa 1 — la plantilla del borrador de web.
//
// Lo que el prospecto abre en su móvil mientras hablas con él por teléfono.
// Una sola página, sin JavaScript, con sus datos reales de Google.
//
// La estructura es CÓDIGO, no IA: secciones fijas, orden fijo, paleta y
// tipografía por sector. La IA solo pone las palabras (web-draft-ai.ts). Eso
// es lo que permite que el borrador se genere en segundos y que dos negocios
// del mismo sector no salgan cada uno de su padre y de su madre.
//
// Los datos duros —teléfono, dirección, estrellas, número de reseñas— se
// pintan AQUÍ desde la base de datos y nunca se le piden al modelo: son los
// que el dueño del negocio va a mirar primero, y un teléfono alucinado tira
// por tierra la propuesta entera.
//
// Segunda versión (23/09/2026), tras ver la primera sobre un negocio real.
// El texto salió bien; el diseño "se veía muy básico", y con razón: no había
// una sola imagen, el teléfono aparecía cuatro veces sin formato y todas las
// secciones pesaban igual. Una web sin fotos parece un esquema por bien
// escrita que esté, y el borrador se juega el sí en los tres primeros
// segundos. De ahí: portada a pantalla con imagen de fondo, tipografía por
// sector, tarjetas con aire, banda de reseñas y UNA llamada a la acción
// repetida donde toca, no en todas partes.
// =============================================================================

export interface WebDraftTheme {
  /** Nombre humano, para el panel de operador y para no repetir paleta entre
   *  competidores de la misma zona cuando llegue la capa 2. */
  key: string;
  accent: string;
  accentDark: string;
  tint: string;
  /** Familia tipográfica de titulares, de Google Fonts. Cambia el carácter de
   *  la página más que ningún otro ajuste, y es gratis. */
  headingFont: string;
  headingStack: string;
}

const THEMES: Readonly<Record<string, WebDraftTheme>> = Object.freeze({
  beauty: {
    key: 'beauty',
    accent: '#b4467a',
    accentDark: '#6d2748',
    tint: '#fdf2f7',
    headingFont: 'Playfair+Display:wght@600;700',
    headingStack: "'Playfair Display', Georgia, serif",
  },
  trades: {
    key: 'trades',
    accent: '#1f6feb',
    accentDark: '#11386f',
    tint: '#eef4ff',
    headingFont: 'Barlow+Condensed:wght@600;700',
    headingStack: "'Barlow Condensed', system-ui, sans-serif",
  },
  health: {
    key: 'health',
    accent: '#0f9488',
    accentDark: '#0a544d',
    tint: '#eefaf8',
    headingFont: 'Source+Sans+3:wght@600;700',
    headingStack: "'Source Sans 3', system-ui, sans-serif",
  },
  food: {
    key: 'food',
    accent: '#c2410c',
    accentDark: '#7a2607',
    tint: '#fff4ed',
    headingFont: 'Bitter:wght@600;700',
    headingStack: "'Bitter', Georgia, serif",
  },
  professional: {
    key: 'professional',
    accent: '#3b5a80',
    accentDark: '#1e293b',
    tint: '#f1f5f9',
    headingFont: 'Libre+Baskerville:wght@700',
    headingStack: "'Libre Baskerville', Georgia, serif",
  },
});

const THEME_BY_PRIMARY_TYPE: Readonly<Record<string, keyof typeof THEMES>> = Object.freeze({
  hair_salon: 'beauty',
  barber_shop: 'beauty',
  beauty_salon: 'beauty',
  nail_salon: 'beauty',
  spa: 'beauty',
  plumber: 'trades',
  electrician: 'trades',
  locksmith: 'trades',
  roofing_contractor: 'trades',
  general_contractor: 'trades',
  painter: 'trades',
  car_repair: 'trades',
  moving_company: 'trades',
  dentist: 'health',
  dental_clinic: 'health',
  physiotherapist: 'health',
  veterinary_care: 'health',
  doctor: 'health',
  restaurant: 'food',
  cafe: 'food',
  bakery: 'food',
  lawyer: 'professional',
  accounting: 'professional',
  real_estate_agency: 'professional',
  insurance_agency: 'professional',
});

/** Sector desconocido → oficios, que es el sector principal del plan y la
 *  paleta más neutra de las cinco. */
export function themeFor(primaryType: string | null): WebDraftTheme {
  const key = primaryType ? THEME_BY_PRIMARY_TYPE[primaryType] : undefined;
  return THEMES[key ?? 'trades'];
}

// A11 capa 2 — variantes de una misma familia.
//
// La familia la manda el sector (una peluquería no se vende con los colores
// de una fontanería), pero DENTRO de la familia hacen falta versiones
// distintas: el escenario que hace daño de verdad es que dos negocios del
// mismo rubro y la misma zona reciban la misma web, porque se conocen y se
// enseñan las cosas. Tres variantes por familia cubren a los tres
// competidores que el informe compara.
//
// Son desplazamientos de tono sobre el color de la familia, no paletas
// inventadas: siguen siendo reconocibles como del mismo sector.
//
// Ocho y no tres (24/09/2026). Con tres, el primer barrido real sobre Las
// Palmas generó cinco borradores de peluquería y los dos últimos repitieron
// variante: tres estaba pensado para los tres competidores que compara el
// informe, pero el barrido no compara, barre la ciudad entera. Con ocho hacen
// falta nueve negocios del mismo rubro y zona para que se repita una.
export const VARIANTS_PER_THEME = 8;

/** Cada variante mezcla el color de la familia con un tercero. Los ocho
 *  destinos están elegidos para que ninguno se coma la identidad del sector:
 *  la mezcla nunca baja del 72 % del color base. */
const VARIANT_SHIFT: Readonly<Record<number, { accent: string; accentDark: string; tint: string } | null>> =
  Object.freeze({
    1: null, // la familia tal cual
    2: shift('#e2a03f', '#6b3f10', '#fff6e8'), // cálido
    3: shift('#111827', '#000000', '#eef1f6'), // oscuro
    4: shift('#0f9488', '#07403a', '#e9f7f5'), // verde azulado
    5: shift('#7c3aed', '#3b1877', '#f3eefe'), // violeta
    6: shift('#b91c1c', '#5c0f0f', '#fdeeee'), // rojo
    7: shift('#0369a1', '#053b57', '#eaf4fb'), // azul profundo
    8: shift('#4d7c0f', '#26400a', '#f2f8e8'), // oliva
  });

function shift(accent: string, dark: string, tint: string): { accent: string; accentDark: string; tint: string } {
  return {
    accent: `color-mix(in srgb, var(--base) 78%, ${accent})`,
    accentDark: `color-mix(in srgb, var(--base-dark) 80%, ${dark})`,
    tint: `color-mix(in srgb, var(--base-tint) 88%, ${tint})`,
  };
}

/** 'beauty-2' → la familia beauty con el desplazamiento 2. Un valor
 *  desconocido cae a la variante 1, que es la familia tal cual: un borrador
 *  guardado con una clave vieja tiene que seguir pintándose. */
export function themeForVariant(themeKey: string): { theme: WebDraftTheme; variant: number } {
  const [family, raw] = themeKey.split('-');
  const variant = Number(raw);
  const theme = THEMES[family] ?? THEMES.trades;
  return { theme, variant: Number.isInteger(variant) && variant >= 1 && variant <= VARIANTS_PER_THEME ? variant : 1 };
}

/**
 * La portada usa la foto del sector si está subida, y si no un degradado
 * generado con su color. Las dos rutas se listan en el CSS en ese orden: el
 * navegador usa la primera que exista.
 *
 * Por qué así y no comprobando el archivo en disco: esta función es pura y se
 * prueba sin sistema de ficheros, y el navegador ya sabe resolverlo. Ver
 * public/web-draft/README.md para qué foto poner y de dónde sacarla.
 */
export function heroImageUrls(theme: WebDraftTheme): string[] {
  return [`/web-draft/${theme.key}.jpg`, `/web-draft/${theme.key}.svg`];
}

export interface WebDraftSubject {
  businessName: string;
  primaryType: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
}

/** La oferta con la que se cierra el borrador. Configurable porque el precio
 *  es una decisión comercial viva: hoy es la tarifa Express propuesta, y se
 *  cambia aquí sin tocar nada más. */
export interface WebDraftOffer {
  priceLabel: string;
  daysLabel: string;
}

export const DEFAULT_WEB_DRAFT_OFFER: Readonly<WebDraftOffer> = Object.freeze({
  priceLabel: '490 €',
  daysLabel: '7 días',
});

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function telHref(phone: string): string {
  return phone.replace(/[^+0-9]/g, '');
}

/**
 * El teléfono como lo escribe un español, no como lo guarda Google.
 * `+34928040058` en una portada parece un número de serie; `928 04 00 58` se
 * lee y se marca. Un número que no encaje en el patrón español se devuelve
 * tal cual: mejor crudo que mal cortado.
 */
export function formatSpanishPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  const national = digits.startsWith('34') && digits.length === 11 ? digits.slice(2) : digits;
  if (national.length !== 9) return phone.trim();
  return `${national.slice(0, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
}

export function renderWebDraftHtml(params: {
  subject: WebDraftSubject;
  copy: WebDraftCopy;
  offer?: WebDraftOffer;
  generatedAt: Date;
  /** Solo cuando lo abre el operador: el enlace público que puede copiar y
   *  mandar por WhatsApp. El prospecto nunca lo ve — él ya está dentro de ese
   *  enlace, y enseñarle la cocina no ayuda a venderle. */
  shareUrl?: string | null;
  /** La variante guardada en el borrador ('beauty-2'). Sin ella se usa la
   *  familia del sector tal cual, que es lo que hacía la capa 1. */
  themeKey?: string | null;
  /** URL del buzón del formulario. Solo la lleva el sitio PUBLICADO: en un
   *  borrador no hay formulario, porque el negocio todavía no es cliente y
   *  sus visitantes no existen. */
  formAction?: string | null;
}): string {
  const { subject, copy, generatedAt } = params;
  const offer = params.offer ?? DEFAULT_WEB_DRAFT_OFFER;
  const resolved = params.themeKey ? themeForVariant(params.themeKey) : null;
  const theme = resolved?.theme ?? themeFor(subject.primaryType);
  const shift = resolved ? VARIANT_SHIFT[resolved.variant] : null;
  const [photo, fallback] = heroImageUrls(theme);

  const phoneText = subject.phone ? formatSpanishPhone(subject.phone) : null;
  const phoneHref = subject.phone ? telHref(subject.phone) : null;
  const callButton = (label: string): string =>
    phoneHref ? `<a class="cta" href="tel:${esc(phoneHref)}">${esc(label)}</a>` : '';

  // Las reseñas van tal cual vienen de Google. Es el elemento que más
  // convence al dueño de que esto es SU web y no una plantilla genérica.
  const reviewsBlock =
    subject.rating !== null && subject.reviewCount !== null
      ? `<section class="reviews"><div class="wrap">
          <div class="stars" aria-hidden="true">${'★'.repeat(Math.round(subject.rating))}</div>
          <p class="score"><strong>${subject.rating.toFixed(1)}</strong> sobre 5</p>
          <p class="count">${new Intl.NumberFormat('es-ES').format(subject.reviewCount)} reseñas en Google</p>
        </div></section>`
      : '';

  const servicesBlock =
    copy.services.length > 0
      ? `<section id="servicios"><div class="wrap">
          <h2>Servicios</h2>
          <div class="grid">
            ${copy.services
              .map(
                (s, i) =>
                  `<article><span class="num">${String(i + 1).padStart(2, '0')}</span>
                    <h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></article>`,
              )
              .join('')}
          </div>
        </div></section>`
      : '';


  // El formulario es lo ÚNICO del sitio que depende del portal, y solo lo
  // lleva el sitio publicado. Si el envío falla —servidor caído, visitante
  // sin cobertura— no se le deja con un formulario mudo: se le enseña el
  // teléfono, que es lo que el negocio quería de todas formas.
  const fallbackNote =
    phoneText && phoneHref
      ? 'No hemos podido enviarlo. Llámanos al <a href="tel:' + esc(phoneHref) + '">' + esc(phoneText) + '</a>.'
      : 'No hemos podido enviarlo. Inténtalo de nuevo en un momento.';
  const formBlock = params.formAction
    ? [
        '<section id="contacto"><div class="wrap">',
        '  <h2>Escríbenos</h2>',
        '  <p class="lead">Cuéntanos qué necesitas y te respondemos.</p>',
        '  <form id="kairikos-form" class="contact">',
        '    <input name="name" placeholder="Tu nombre" maxlength="200" autocomplete="name">',
        '    <input name="contact" placeholder="Teléfono o email" maxlength="200" required>',
        '    <textarea name="message" rows="4" placeholder="¿Qué necesitas?" maxlength="2000"></textarea>',
        '    <button type="submit">Enviar</button>',
        '    <p class="form-note" id="kairikos-form-note" hidden></p>',
        '  </form>',
        '</div></section>',
        '<script>',
        '(function () {',
        '  var form = document.getElementById("kairikos-form");',
        '  var note = document.getElementById("kairikos-form-note");',
        '  if (!form) return;',
        '  form.addEventListener("submit", function (event) {',
        '    event.preventDefault();',
        '    var data = new FormData(form);',
        '    note.hidden = false;',
        '    note.textContent = "Enviando…";',
        '    fetch(' + JSON.stringify(params.formAction) + ', {',
        '      method: "POST",',
        '      headers: { "content-type": "application/json" },',
        '      body: JSON.stringify({',
        '        name: String(data.get("name") || ""),',
        '        contact: String(data.get("contact") || ""),',
        '        message: String(data.get("message") || "")',
        '      })',
        '    })',
        '      .then(function (res) {',
        '        if (!res.ok) throw new Error("bad_status");',
        '        form.reset();',
        '        note.textContent = "Recibido. Te respondemos enseguida.";',
        '      })',
        '      .catch(function () { note.innerHTML = ' + JSON.stringify(fallbackNote) + '; });',
        '  });',
        '})();',
        '</script>',
      ].join(String.fromCharCode(10))
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Es una propuesta sobre un negocio de terceros: nunca indexada. -->
<meta name="robots" content="noindex, nofollow">
<title>${esc(subject.businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${theme.headingFont}&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  color-scheme: light;
  --base: ${theme.accent};
  --base-dark: ${theme.accentDark};
  --base-tint: ${theme.tint};
  --accent: ${shift ? shift.accent : theme.accent};
  --accent-dark: ${shift ? shift.accentDark : theme.accentDark};
  --tint: ${shift ? shift.tint : theme.tint};
  --ink: #16181d;
  --muted: #5b6472;
}
* { box-sizing: border-box; }
/* Fondo explícito, no heredado del navegador: sin esto, un móvil en modo
   oscuro pinta el cuerpo en negro y las secciones claras quedan con texto
   oscuro sobre negro. Visto en la primera prueba de esta plantilla, y el
   borrador se abre casi siempre en un móvil ajeno. */
body { margin: 0; background: #fff; font-family: 'Inter', system-ui, sans-serif;
  color: var(--ink); line-height: 1.6; }
h1, h2, h3 { font-family: ${theme.headingStack}; font-weight: 700; margin: 0; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 22px; }
a.cta { display: inline-block; background: var(--accent); color: #fff; text-decoration: none;
  padding: 15px 30px; border-radius: 999px; font-weight: 600; letter-spacing: .01em;
  box-shadow: 0 8px 20px rgba(0,0,0,.16); }
a.cta:hover { background: var(--accent-dark); }

/* Cabecera fina y translúcida sobre la portada: la portada tiene que ser lo
   primero que se ve, no una barra de navegación. */
/* En el flujo, no absoluta. Con position:absolute la cabecera y el titular se
   pisaban en cuanto la ventana era baja, porque cada uno se colocaba respecto
   a un origen distinto. Aquí la portada es una columna: cabecera arriba,
   titular abajo, y no hay forma de que se solapen. */
header { position: relative; z-index: 2; padding: 18px 0; }
header .wrap { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
header .brand { color: #fff; font-family: ${theme.headingStack}; font-size: 20px;
  text-shadow: 0 1px 12px rgba(0,0,0,.45); }
header .phone { color: #fff; text-decoration: none; font-weight: 600; font-size: 15px;
  background: rgba(255,255,255,.16); padding: 8px 16px; border-radius: 999px;
  backdrop-filter: blur(6px); }

/* La foto del sector si está subida; si no, el degradado generado. El
   navegador se queda con la primera que exista — ver heroImageUrls. */
/* min-height en max(): con solo 78vh, una ventana baja (un portátil pequeño,
   un móvil apaisado) encogía la portada hasta que la cabecera se comía el
   titular. Visto en la prueba en navegador. */
.hero { position: relative; min-height: max(78vh, 540px); display: flex; flex-direction: column;
  background-image: image-set(url('${photo}') 1x), url('${fallback}');
  background-color: var(--accent-dark); background-size: cover; background-position: center; }
.hero::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,.18) 40%, rgba(0,0,0,.78) 100%); }
.hero > .wrap { position: relative; z-index: 1; margin-top: auto; padding-top: 40px; padding-bottom: 58px; color: #fff; }
.hero h1 { font-size: clamp(30px, 5.4vw, 52px); line-height: 1.08; max-width: 16em;
  text-shadow: 0 2px 24px rgba(0,0,0,.4); }
.hero p { font-size: clamp(16px, 2.2vw, 20px); max-width: 34em; margin: 16px 0 28px;
  color: rgba(255,255,255,.92); }

section { padding: 72px 0; }
section h2 { font-size: clamp(24px, 3.4vw, 34px); margin-bottom: 8px; }
section h2 + p.lead { color: var(--muted); margin: 0 0 30px; max-width: 40em; font-size: 17px; }
.about p { font-size: 18px; color: #333a44; max-width: 42em; }

.grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.grid article { border: 1px solid #e6e9ee; border-radius: 14px; padding: 26px 22px; background: #fff;
  transition: box-shadow .2s, transform .2s; }
.grid article:hover { box-shadow: 0 12px 28px rgba(16,20,28,.09); transform: translateY(-2px); }
.grid .num { display: inline-block; font-family: ${theme.headingStack}; font-size: 13px;
  color: var(--accent); letter-spacing: .14em; margin-bottom: 10px; }
.grid h3 { font-size: 19px; margin-bottom: 8px; }
.grid p { margin: 0; color: var(--muted); font-size: 15px; }

.reviews { background: var(--tint); text-align: center; padding: 58px 0; }
.reviews .stars { color: var(--accent); font-size: 30px; letter-spacing: 5px; }
.reviews .score { font-size: 24px; margin: 10px 0 2px; font-family: ${theme.headingStack}; }
.reviews .count { margin: 0; color: var(--muted); }

form.contact { display: grid; gap: 12px; max-width: 32em; }
form.contact input, form.contact textarea { font: inherit; padding: 12px 14px; border-radius: 10px;
  border: 1px solid #d8dde5; background: #fff; color: var(--ink); width: 100%; }
form.contact button { font: inherit; font-weight: 600; background: var(--accent); color: #fff; border: 0;
  padding: 13px 26px; border-radius: 999px; cursor: pointer; justify-self: start; }
form.contact .form-note { margin: 0; font-size: 14px; color: var(--muted); }
.closing { background: var(--accent-dark); color: #fff; text-align: center; }
.closing h2 { color: #fff; margin-bottom: 10px; }
.closing .tel { display: block; font-family: ${theme.headingStack}; font-size: clamp(26px, 4.4vw, 38px);
  color: #fff; text-decoration: none; margin: 6px 0 26px; }

footer { background: #10141a; color: #97a1b0; font-size: 13px; padding: 30px 0 40px; }
footer strong { color: #d6dce5; }
footer .note { margin: 16px 0 0; padding-top: 14px; border-top: 1px solid #222934; }

.banner { background: #111827; color: #fff; padding: 11px 0; font-size: 13px; position: relative; z-index: 3; }
.banner strong { color: #ffd166; }
.banner .share { color: #9aa6b8; }
.banner code { color: #cfe0ff; font-size: 12px; word-break: break-all; }
.banner .share { color: #9aa6b8; }
.banner code { color: #cfe0ff; font-size: 12px; word-break: break-all; }
@media (max-width: 640px) {
  .hero { min-height: 74vh; }
  section { padding: 52px 0; }
  header .brand { font-size: 17px; }
}
</style>
</head>
<body>
<!-- Nunca se le enseña esto a un negocio sin decirle qué es. Que sea una
     propuesta y no su web publicada tiene que estar escrito en la propia
     página: el comercial lo dice por teléfono, pero el enlace se reenvía. -->
<div class="banner"><div class="wrap">
  Propuesta de Kairikos para <strong>${esc(subject.businessName)}</strong> ·
  borrador con sus datos públicos de Google, todavía no publicado
  ${params.shareUrl ? `<br><span class="share">Enlace para mandarle: <code>${esc(params.shareUrl)}</code></span>` : ''}
</div></div>

<div class="hero">
  <header><div class="wrap">
    <span class="brand">${esc(subject.businessName)}</span>
    ${phoneText && phoneHref ? `<a class="phone" href="tel:${esc(phoneHref)}">${esc(phoneText)}</a>` : ''}
  </div></header>
  <div class="wrap">
    <h1>${esc(copy.headline)}</h1>
    ${copy.subheadline ? `<p>${esc(copy.subheadline)}</p>` : ''}
    ${callButton(phoneText ? `Llamar al ${phoneText}` : 'Pedir cita')}
  </div>
</div>

${
  copy.about
    ? `<section class="about"><div class="wrap"><h2>El negocio</h2><p>${esc(copy.about)}</p></div></section>`
    : ''
}

${servicesBlock}

${reviewsBlock}

${formBlock}

<section class="closing"><div class="wrap">
  <h2>${esc(copy.callToAction || 'Pide tu cita hoy mismo')}</h2>
  ${phoneText && phoneHref ? `<a class="tel" href="tel:${esc(phoneHref)}">${esc(phoneText)}</a>` : ''}
  ${callButton('Llamar ahora')}
</div></section>

<footer><div class="wrap">
  <strong>${esc(subject.businessName)}</strong><br>
  ${esc(subject.address ?? subject.city ?? '')}
  <p class="note">
    Borrador generado por Kairikos el ${generatedAt.toLocaleDateString('es-ES')}.
    Las imágenes son de muestra: en tu web irían las tuyas.
    Tu web publicada, con tus fotos y tu dominio: ${esc(offer.priceLabel)} y lista en ${esc(offer.daysLabel)}.
  </p>
</div></footer>
</body>
</html>`;
}
