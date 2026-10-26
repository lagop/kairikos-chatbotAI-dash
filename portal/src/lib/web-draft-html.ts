import type { WebDraftCopy } from './web-draft-ai';
import {
  openEveryDaySummary,
  type DraftReview,
  type OpeningHoursRow,
  type RenderHighlight,
} from './web-draft-reviews';

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
//
// Tercera versión (26/10/2026), tras la demo hecha a mano para Fontanería
// Suárez: portada oscura con el titular grande y el botón de llamar en la
// cabecera; la banda «Lo que repiten sus clientes» con citas literales;
// reseñas de verdad, horario y zona. Lo que la hizo mejor no fue el diseño
// sino los DATOS — el borrador de ese mismo negocio no tenía ni estrellas ni
// horario —, así que el diseño solo se luce cuando hay datos: cada sección
// que depende de Google desaparece si Google no la da. Nunca «0 reseñas»,
// nunca una valoración baja en portada: nada que juegue en contra.
//
// Contraste: el color del sector no se usa nunca como fondo de un texto
// blanco ni como texto sobre blanco tal cual; se aclara (--glow) para el
// fondo oscuro y se oscurece (--deep) para el claro. Así cualquier familia y
// cualquiera de sus ocho variantes pasa AA sin calcularlo variante a
// variante.
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
  /** 26/10/2026 — lo que sale de Google en el momento (web-draft-live.ts).
   *  Todo opcional: sin ello, sus secciones no se pintan. */
  hours?: OpeningHoursRow[];
  googleMapsUri?: string | null;
  reviews?: DraftReview[];
  highlights?: RenderHighlight[];
}

/** El oficio en singular para la línea sobre el titular. Lo que no esté aquí
 *  se queda sin oficio y la línea dice solo la ciudad. */
const PRIMARY_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  plumber: 'Fontanería',
  electrician: 'Electricidad',
  locksmith: 'Cerrajería',
  roofing_contractor: 'Cubiertas y tejados',
  general_contractor: 'Reformas',
  painter: 'Pintura',
  car_repair: 'Taller mecánico',
  moving_company: 'Mudanzas',
  hair_salon: 'Peluquería',
  barber_shop: 'Barbería',
  beauty_salon: 'Estética',
  nail_salon: 'Uñas',
  spa: 'Spa',
  dentist: 'Clínica dental',
  dental_clinic: 'Clínica dental',
  physiotherapist: 'Fisioterapia',
  veterinary_care: 'Veterinaria',
  doctor: 'Consulta médica',
  restaurant: 'Restaurante',
  cafe: 'Cafetería',
  bakery: 'Panadería',
  lawyer: 'Abogados',
  accounting: 'Asesoría',
  real_estate_agency: 'Inmobiliaria',
  insurance_agency: 'Seguros',
});

/** Por debajo de esto la valoración no sale en el borrador: es una propuesta
 *  de venta, y una nota floja en la portada juega en contra. */
export const MIN_RATING_TO_SHOW = 4;

/** La oferta con la que se cierra el borrador. Las páginas públicas la sacan
 *  del catálogo (el precio de 'web'); esto es solo el respaldo.
 *
 *  25/10/2026 — decía «490 € y lista en 7 días»: la tarifa Express que el plan
 *  propuso y nunca se aprobó, y un plazo que no promete ninguna otra página.
 *  El catálogo cobra 799 €, y el plazo honesto es el de las preguntas
 *  frecuentes: unos días desde el visto bueno. */
export interface WebDraftOffer {
  priceLabel: string;
  daysLabel: string;
}

export const DEFAULT_WEB_DRAFT_OFFER: Readonly<WebDraftOffer> = Object.freeze({
  priceLabel: '799 €, pago único',
  daysLabel: 'unos días desde que das el visto bueno',
});

/** Qué puede hacer quien ve su borrador (25/10/2026): comprarla sin llamada
 *  o, si este mes ya no quedan webs por autoservicio, reservar una llamada.
 *  Ver lib/web-self-serve.ts. */
export type WebDraftPurchaseCta =
  | { kind: 'buy'; href: string; priceLabel: string }
  | { kind: 'call'; href: string };

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

function stars(rating: number): string {
  return '★'.repeat(Math.max(1, Math.min(5, Math.round(rating))));
}

function ratingText(rating: number): string {
  return rating.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Lo que solo existe mientras es una propuesta. website-build.ts lo quita
 *  entero del sitio publicado (stripDraftChrome). */
function draftOnly(html: string): string {
  return html ? `<!--draft-only-->${html}<!--/draft-only-->` : '';
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
  /** Solo las dos páginas públicas del borrador. Ni el sitio publicado ni la
   *  vista del operador lo llevan. */
  purchase?: WebDraftPurchaseCta | null;
}): string {
  const { subject, copy, generatedAt } = params;
  const offer = params.offer ?? DEFAULT_WEB_DRAFT_OFFER;
  const resolved = params.themeKey ? themeForVariant(params.themeKey) : null;
  const theme = resolved?.theme ?? themeFor(subject.primaryType);
  const shift = resolved ? VARIANT_SHIFT[resolved.variant] : null;
  const [photo, fallback] = heroImageUrls(theme);

  const phoneText = subject.phone ? formatSpanishPhone(subject.phone) : null;
  const phoneHref = subject.phone ? telHref(subject.phone) : null;
  const hasPhone = Boolean(phoneText && phoneHref);

  // Los datos duros salen de aquí, nunca del modelo. La valoración solo se
  // enseña si existe, tiene reseñas detrás y no juega en contra.
  const showRating =
    subject.rating !== null &&
    subject.reviewCount !== null &&
    subject.reviewCount > 0 &&
    subject.rating >= MIN_RATING_TO_SHOW;
  const reviewCountText = subject.reviewCount !== null ? new Intl.NumberFormat('es-ES').format(subject.reviewCount) : '';
  const reviews = (subject.reviews ?? []).slice(0, 3);
  const highlights = (subject.highlights ?? []).slice(0, 4);
  const hours = subject.hours ?? [];
  const hoursSummary = openEveryDaySummary(hours);
  const kind = subject.primaryType ? PRIMARY_TYPE_LABEL[subject.primaryType] : undefined;
  const eyebrow = [kind, subject.city ? `en ${subject.city}` : null].filter(Boolean).join(' ');
  const mapsHref = subject.googleMapsUri ?? null;

  const callButton = (label: string, cls = 'btn btn-primary'): string =>
    hasPhone ? `<a class="${cls}" href="tel:${esc(phoneHref!)}">${esc(label)}</a>` : '';

  const navLinks = [
    copy.services.length > 0 ? '<a href="#servicios">Servicios</a>' : '',
    reviews.length > 0 ? '<a href="#opiniones">Opiniones</a>' : '',
    hours.length > 0 || subject.address ? '<a href="#horario">Horario y zona</a>' : '',
  ].join('');

  const trustItems = [
    showRating
      ? `<li><span class="stars" aria-hidden="true">${stars(subject.rating!)}</span> <strong>${ratingText(subject.rating!)}</strong> en ${reviewCountText} reseñas de Google</li>`
      : '',
    hoursSummary ? `<li>${esc(hoursSummary)}</li>` : '',
  ].join('');

  const highlightsBlock =
    highlights.length >= 2
      ? `<section class="band" aria-labelledby="t-repiten"><div class="wrap">
  <h2 id="t-repiten">Lo que repiten sus clientes</h2>
  <ul class="band-grid">
    ${highlights
      .map(
        (h) => `<li><h3>${esc(h.title)}</h3><p>«${esc(h.quote)}»</p><span class="who">${esc(h.author)} · reseña de Google</span></li>`,
      )
      .join('\n    ')}
  </ul>
</div></section>`
      : '';

  const servicesBlock =
    copy.services.length > 0
      ? `<section class="services" id="servicios" aria-labelledby="t-servicios"><div class="wrap">
  <p class="eyebrow">Servicios</p>
  <h2 id="t-servicios">Qué hace</h2>
  ${copy.about ? `<p class="lead">${esc(copy.about)}</p>` : ''}
  <div class="grid">
    ${copy.services
      .map(
        (s, i) =>
          `<article><span class="num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></article>`,
      )
      .join('\n    ')}
  </div>
  ${draftOnly('<p class="note">Servicios orientativos para el borrador: en la web publicada irían los que de verdad hace.</p>')}
</div></section>`
      : '';

  // Políticas de Places: atribución del autor (nombre y enlace a su perfil),
  // aviso de cómo se filtran y ordenan, aviso de traducción, enlace a la
  // ficha en Google Maps y la atribución «Google Maps».
  const reviewCards = reviews
    .map((r) => {
      const author = r.authorUri
        ? `<a href="${esc(r.authorUri)}" rel="noopener nofollow" target="_blank">${esc(r.author)}</a>`
        : esc(r.author);
      const meta = [r.relativeTime ? esc(r.relativeTime.toLocaleLowerCase('es-ES')) : '', 'reseña de Google', r.translated ? 'traducida por Google' : '']
        .filter(Boolean)
        .join(' · ');
      return `<figure class="review"><div class="stars" aria-label="${r.rating} de 5 estrellas">${stars(r.rating)}</div><blockquote><p>${esc(r.text)}</p></blockquote><figcaption><strong>${author}</strong> · ${meta}</figcaption></figure>`;
    })
    .join('\n    ');
  const reviewsBlock =
    reviews.length > 0
      ? `<section class="reviews" id="opiniones" aria-labelledby="t-opiniones"><div class="wrap">
  <div class="reviews-head">
    <div><p class="eyebrow">Opiniones</p><h2 id="t-opiniones">Lo que dicen sus clientes</h2></div>
    ${showRating ? `<p class="score"><span class="stars" aria-hidden="true">${stars(subject.rating!)}</span> <strong>${ratingText(subject.rating!)}</strong> · ${reviewCountText} reseñas</p>` : ''}
  </div>
  <div class="review-grid">
    ${reviewCards}
  </div>
  <p class="note">Reseñas de Google de 4 y 5 estrellas, en el orden de relevancia de Google. Fuente: Google Maps.</p>
  ${mapsHref && showRating ? `<a class="more" href="${esc(mapsHref)}" rel="noopener" target="_blank">Ver las ${reviewCountText} reseñas en Google <span aria-hidden="true">→</span></a>` : ''}
</div></section>`
      : showRating
        ? // Sin texto de reseñas pero con valoración: el bloque compacto de antes.
          `<section class="reviews compact" id="opiniones"><div class="wrap">
  <p class="score"><span class="stars" aria-hidden="true">${stars(subject.rating!)}</span> <strong>${ratingText(subject.rating!)}</strong> sobre 5 · ${reviewCountText} reseñas en Google</p>
</div></section>`
        : '';

  const hoursBlock =
    hours.length > 0 || subject.address
      ? `<section class="hours" id="horario" aria-labelledby="t-horario"><div class="wrap hours-grid">
  <div>
    <p class="eyebrow">Horario y zona</p>
    <h2 id="t-horario">${hours.length > 0 ? 'Cuándo está' : 'Dónde está'}</h2>
    ${
      hours.length > 0
        ? `<table class="hours-table"><caption class="sr-only">Horario</caption><tbody>${hours
            .map((h) => `<tr><th scope="row">${esc(h.days)}</th><td>${esc(h.hours)}</td></tr>`)
            .join('')}</tbody></table>`
        : ''
    }
  </div>
  ${
    subject.address
      ? `<div class="place"><h3>Dónde está</h3><address>${esc(subject.address)}</address>${
          mapsHref ? `<a class="more" href="${esc(mapsHref)}" rel="noopener" target="_blank">Cómo llegar <span aria-hidden="true">→</span></a>` : ''
        }</div>`
      : ''
  }
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
        '<section id="contacto" class="form-section"><div class="wrap">',
        '  <h2>Escríbenos</h2>',
        '  <p class="lead">Cuéntanos qué necesitas y te respondemos.</p>',
        '  <form id="kairikos-form" class="contact">',
        '    <label for="kf-name">Nombre</label>',
        '    <input id="kf-name" name="name" maxlength="200" autocomplete="name">',
        '    <label for="kf-contact">Teléfono o email</label>',
        '    <input id="kf-contact" name="contact" maxlength="200" required>',
        '    <label for="kf-message">¿Qué necesitas?</label>',
        '    <textarea id="kf-message" name="message" rows="4" maxlength="2000"></textarea>',
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

  // 25/10/2026 — «La quiero». Va en el color de la franja de Kairikos y no en
  // el del negocio: es nuestra oferta, no una sección de su web, y no debe
  // confundirse con ella. Con el tope del mes lleno, el mismo sitio ofrece una
  // llamada: quien ha llegado hasta aquí no puede encontrarse sin salida.
  const purchase = params.purchase ?? null;
  const purchaseLink = !purchase
    ? ''
    : purchase.kind === 'buy'
      ? `<a class="buy" href="${esc(purchase.href)}" data-kairikos="comprar">La quiero · ${esc(purchase.priceLabel)}</a>`
      : `<a class="buy" href="${esc(purchase.href)}" target="_blank" rel="noopener" data-kairikos="llamada">Reservar una llamada</a>`;
  const purchaseBlock = !purchase
    ? ''
    : purchase.kind === 'buy'
      ? `<section class="offer" id="oferta"><div class="wrap">
  <h2>¿Te gusta? Puede ser tuya</h2>
  <p>Tu web publicada: ${esc(offer.priceLabel)}, con dominio y alojamiento el primer año incluidos.
    La repasamos contigo y la publicamos unos días después de que des el visto bueno.</p>
  ${purchaseLink}
</div></section>`
      : `<section class="offer" id="oferta"><div class="wrap">
  <h2>¿Te gusta?</h2>
  <p>Este mes ya no nos quedan huecos para webs sin llamada. Reserva 20 minutos y la vemos juntos.</p>
  ${purchaseLink}
</div></section>`;

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
  /* El color del sector, nunca tal cual sobre blanco o bajo texto blanco:
     aclarado para el fondo oscuro, oscurecido para el claro. */
  --night: color-mix(in srgb, var(--accent-dark) 30%, #0b0f14);
  --night-2: color-mix(in srgb, var(--accent-dark) 40%, #121821);
  --glow: color-mix(in srgb, var(--accent) 50%, #ffffff);
  --deep: color-mix(in srgb, var(--accent-dark) 85%, #000000);
  --paper: #fbf9f6;
  --ink: #16181d;
  --muted: #535d69;
  --line: #e6e1d8;
  --on-night: #d5dce4;
}
* { box-sizing: border-box; }
/* Fondo explícito, no heredado del navegador: sin esto, un móvil en modo
   oscuro pinta el cuerpo en negro y las secciones claras quedan con texto
   oscuro sobre negro. Visto en la primera prueba de esta plantilla, y el
   borrador se abre casi siempre en un móvil ajeno. */
body { margin: 0; background: var(--paper); font-family: 'Inter', system-ui, sans-serif; color: var(--ink); line-height: 1.6; }
h1, h2, h3 { font-family: ${theme.headingStack}; font-weight: 700; margin: 0; line-height: 1.12; }
a { color: inherit; }
.wrap { width: min(1100px, 100% - 32px); margin-inline: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
:focus-visible { outline: 3px solid var(--glow); outline-offset: 3px; border-radius: 6px; }
section[id] { scroll-margin-top: 76px; }

.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 24px;
  border-radius: 999px; font-weight: 600; text-decoration: none; border: 2px solid transparent; }
.btn-primary { background: var(--glow); color: #0b0f14; }
.btn-primary:hover { background: #ffffff; }
.btn-ghost { border-color: rgba(255,255,255,.4); color: #fff; }
.btn-ghost:hover { border-color: #fff; }

.banner { background: #111827; color: #fff; padding: 10px 0; font-size: 13px; text-align: center; }
.banner strong { color: #ffd166; }
.banner .share { color: #9aa6b8; }
.banner code { color: #cfe0ff; font-size: 12px; word-break: break-all; }
.banner a.buy-link { color: #ffd166; font-weight: 600; white-space: nowrap; }

/* Cabecera fija y oscura: el botón de llamar se ve siempre, que es para lo
   que existe esta web. */
.site-header { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--night) 94%, transparent); color: #fff; }
.header-row { display: flex; align-items: center; gap: 20px; min-height: 66px; }
.brand { font-family: ${theme.headingStack}; font-size: 20px; font-weight: 700; margin-right: auto; }
.main-nav { display: flex; gap: 20px; }
.main-nav a { color: var(--on-night); text-decoration: none; font-size: 15px; }
.main-nav a:hover { color: #fff; }
.btn-call { min-height: 42px; padding: 0 18px; flex: none; }

.hero { background: var(--night); color: #fff; padding: 64px 0 76px; }
.hero-grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 44px; align-items: center; }
.eyebrow { margin: 0 0 12px; font-size: 13px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--deep); }
.hero .eyebrow { color: var(--glow); }
.hero h1 { font-size: clamp(34px, 5.6vw, 64px); }
.hero-lead { font-size: clamp(17px, 2vw, 20px); color: var(--on-night); max-width: 34em; margin: 20px 0 28px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
.trust { list-style: none; padding: 0; margin: 30px 0 0; display: flex; flex-wrap: wrap; gap: 10px 26px; color: var(--on-night); font-size: 15px; }
.trust strong { color: #fff; }
.stars { color: var(--glow); letter-spacing: 2px; }
/* La foto del sector si está subida; si no, el degradado generado. El
   navegador se queda con la primera que exista — ver heroImageUrls. */
.hero-photo { margin: 0; }
.hero-photo .img { aspect-ratio: 4 / 4.2; border-radius: 22px; background-color: var(--night-2);
  background-image: image-set(url('${photo}') 1x), url('${fallback}'); background-size: cover; background-position: center;
  box-shadow: 0 28px 56px rgba(0,0,0,.35); }
.hero-photo figcaption { margin-top: 10px; font-size: 12px; color: var(--on-night); }

.band { background: var(--night-2); color: #fff; padding: 52px 0; }
.band h2 { font-size: clamp(22px, 2.6vw, 28px); margin-bottom: 24px; }
.band-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
.band-grid li { border-top: 3px solid var(--glow); padding-top: 14px; }
.band-grid h3 { font-size: 18px; margin-bottom: 6px; }
.band-grid p { margin: 0 0 8px; color: var(--on-night); font-size: 15px; }
.who { font-size: 13px; color: var(--on-night); }

section h2 { font-size: clamp(26px, 3.8vw, 40px); }
.services, .reviews, .hours, .form-section { padding: 80px 0; }
.lead { color: var(--muted); max-width: 42em; margin: 14px 0 0; font-size: 17px; }
.grid { margin-top: 30px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.grid article { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 24px 22px; }
.num { display: block; font-family: ${theme.headingStack}; font-size: 14px; color: var(--deep); letter-spacing: .12em; margin-bottom: 10px; font-weight: 700; }
.grid h3 { font-size: 19px; margin-bottom: 6px; }
.grid p { margin: 0; color: var(--muted); font-size: 15px; }
.note { margin: 18px 0 0; font-size: 13px; color: var(--muted); }

.reviews { background: #fff; border-block: 1px solid var(--line); }
.reviews .stars { color: var(--deep); }
.reviews-head { display: flex; justify-content: space-between; align-items: end; gap: 16px; flex-wrap: wrap; }
.score { margin: 0; font-size: 18px; }
.review-grid { margin-top: 30px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.review { margin: 0; background: var(--paper); border-radius: 14px; padding: 24px 22px; display: flex; flex-direction: column; gap: 12px; }
.review blockquote { margin: 0; }
.review blockquote p { margin: 0; }
.review figcaption { font-size: 14px; color: var(--muted); margin-top: auto; }
.review figcaption a { color: var(--ink); }
.reviews.compact { padding: 44px 0; text-align: center; }
a.more { display: inline-block; margin-top: 18px; font-weight: 600; color: var(--deep); text-underline-offset: 4px; }

.hours-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 44px; align-items: start; }
.hours-table { margin-top: 22px; border-collapse: collapse; width: 100%; max-width: 440px; }
.hours-table th, .hours-table td { text-align: left; padding: 11px 0; border-bottom: 1px solid var(--line); font-weight: 500; }
.hours-table td { text-align: right; font-variant-numeric: tabular-nums; }
.place { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 26px; }
.place h3 { font-size: 20px; margin-bottom: 8px; }
.place address { font-style: normal; color: var(--muted); }

form.contact { display: grid; gap: 8px; max-width: 32em; margin-top: 24px; }
form.contact label { font-size: 14px; font-weight: 600; }
form.contact input, form.contact textarea { font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid #c9d0d9; background: #fff; color: var(--ink); width: 100%; }
form.contact button { font: inherit; font-weight: 600; background: var(--deep); color: #fff; border: 0; padding: 13px 26px; border-radius: 999px; cursor: pointer; justify-self: start; margin-top: 8px; }
form.contact .form-note { margin: 0; font-size: 14px; color: var(--muted); }

.closing { background: var(--night); color: #fff; padding: 76px 0; text-align: center; }
.closing h2 { margin-bottom: 8px; }
.closing .tel { display: inline-block; font-family: ${theme.headingStack}; font-size: clamp(34px, 6vw, 58px); font-weight: 700; color: var(--glow); text-decoration: none; margin: 6px 0 22px; }

.offer { background: #111827; color: #e5e9f0; text-align: center; padding: 64px 0; }
.offer h2 { color: #fff; margin-bottom: 10px; }
.offer p { max-width: 36em; margin: 0 auto 24px; color: #c3cad6; }
a.buy { display: inline-block; background: #ffd166; color: #111827; text-decoration: none; font-weight: 700; padding: 15px 30px; border-radius: 999px; }
a.buy:hover { background: #ffe09a; }

footer { background: #0b0f14; color: #9aa4b2; font-size: 13px; padding: 30px 0 40px; }
footer strong { color: #e1e6ec; }
footer .note { margin: 14px 0 0; padding-top: 14px; border-top: 1px solid #222934; color: #9aa4b2; }

@media (max-width: 900px) {
  .hero-grid, .hours-grid { grid-template-columns: 1fr; }
  .hero-photo .img { aspect-ratio: 16 / 10; }
}
@media (max-width: 720px) {
  .main-nav { display: none; }
}
@media (max-width: 560px) {
  .hero { padding: 44px 0 56px; }
  .services, .reviews, .hours, .form-section, .closing { padding: 56px 0; }
  .actions .btn { width: 100%; }
  .brand { font-size: 17px; }
}
@media (max-width: 380px) {
  .btn-call .num-label { display: none; }
  .btn-call::after { content: 'Llamar'; }
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
  ${purchase?.kind === 'buy' ? `· <a class="buy-link" href="#oferta">La quiero</a>` : ''}
  ${params.shareUrl ? `<br><span class="share">Enlace para mandarle: <code>${esc(params.shareUrl)}</code></span>` : ''}
</div></div>

<header class="site-header"><div class="wrap header-row">
  <span class="brand">${esc(subject.businessName)}</span>
  ${navLinks ? `<nav class="main-nav" aria-label="Secciones">${navLinks}</nav>` : ''}
  ${hasPhone ? `<a class="btn btn-primary btn-call" href="tel:${esc(phoneHref!)}" aria-label="Llamar al ${esc(phoneText!)}"><span class="num-label">${esc(phoneText!)}</span></a>` : ''}
</div></header>

<main>
<section class="hero"><div class="wrap hero-grid">
  <div>
    ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
    <h1>${esc(copy.headline)}</h1>
    ${copy.subheadline ? `<p class="hero-lead">${esc(copy.subheadline)}</p>` : ''}
    <div class="actions">
      ${callButton(phoneText ? `Llamar al ${phoneText}` : 'Llamar')}
      ${reviews.length > 0 ? '<a class="btn btn-ghost" href="#opiniones">Ver qué dicen sus clientes</a>' : ''}
    </div>
    ${trustItems ? `<ul class="trust" aria-label="Datos de Google">${trustItems}</ul>` : ''}
  </div>
  <figure class="hero-photo">
    <div class="img" role="img" aria-label="Imagen de muestra del sector"></div>
    ${draftOnly('<figcaption>Imagen de muestra: en la web publicada irían sus fotos</figcaption>')}
  </figure>
</div></section>

${highlightsBlock}

${servicesBlock}

${reviewsBlock}

${hoursBlock}

${formBlock}

<section class="closing"><div class="wrap">
  <h2>${esc(copy.callToAction || 'Pide tu cita hoy mismo')}</h2>
  ${hasPhone ? `<a class="tel" href="tel:${esc(phoneHref!)}">${esc(phoneText!)}</a><br>` : ''}
  ${callButton('Llamar ahora')}
</div></section>
${purchaseBlock}
</main>

<footer><div class="wrap">
  <strong>${esc(subject.businessName)}</strong><br>
  ${esc(subject.address ?? subject.city ?? '')}
  <p class="note">
    Borrador generado por Kairikos el ${generatedAt.toLocaleDateString('es-ES')}, con datos públicos de Google Maps.
    Las imágenes son de muestra: en tu web irían las tuyas.
    Tu web publicada, con tus fotos y tu dominio: ${esc(offer.priceLabel)} y lista en ${esc(offer.daysLabel)}.
  </p>
</div></footer>
</body>
</html>`;
}
