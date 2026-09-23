import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// A11, capa 1 — la plantilla del borrador de web.
//
// Lo que el prospecto abre en su móvil mientras hablas con él por teléfono.
// Una sola página, sin JavaScript, con sus datos reales de Google.
//
// La estructura es CÓDIGO, no IA: secciones fijas, orden fijo, paleta elegida
// por sector. La IA solo pone las palabras (web-draft-ai.ts). Eso es lo que
// permite que el borrador se genere en segundos y que dos negocios del mismo
// sector no salgan con webs raras cada uno de su padre y de su madre.
//
// Y por eso los datos duros —teléfono, dirección, estrellas, número de
// reseñas— se pintan AQUÍ desde la base de datos y nunca se le piden al
// modelo: son los que el dueño del negocio va a mirar primero, y un teléfono
// alucinado tira por tierra la propuesta entera.
//
// Capa 1 de cuatro: un borrador bajo demanda, sobre una plantilla por sector,
// sin editor, sin dominio y sin publicación. Las capas 2-4 (generación
// automática, formulario público y el producto web de verdad) están en el
// plan; esto se escribe ya pensando en ellas, de ahí que el contenido viva en
// un objeto y no incrustado en el HTML.
// =============================================================================

export interface WebDraftTheme {
  /** Nombre humano, para el panel de operador y para no repetir paleta entre
   *  competidores de la misma zona cuando llegue la capa 2. */
  key: string;
  accent: string;
  accentDark: string;
  tint: string;
  fontHeading: string;
}

/** Una paleta por familia de sector. No es decoración: una peluquería y una
 *  fontanería de urgencias no se venden con los mismos colores, y el prospecto
 *  tiene que reconocerse en lo que ve en los tres primeros segundos. */
const THEMES: Readonly<Record<string, WebDraftTheme>> = Object.freeze({
  beauty: { key: 'beauty', accent: '#b4467a', accentDark: '#7d2f54', tint: '#fdf2f7', fontHeading: "'Georgia', serif" },
  trades: { key: 'trades', accent: '#1f6feb', accentDark: '#144a9e', tint: '#eef4ff', fontHeading: "system-ui, sans-serif" },
  health: { key: 'health', accent: '#0f9488', accentDark: '#0b6b62', tint: '#eefaf8', fontHeading: "system-ui, sans-serif" },
  food: { key: 'food', accent: '#c2410c', accentDark: '#8a2d08', tint: '#fff4ed', fontHeading: "'Georgia', serif" },
  professional: { key: 'professional', accent: '#334155', accentDark: '#1e293b', tint: '#f1f5f9', fontHeading: "'Georgia', serif" },
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

export function renderWebDraftHtml(params: {
  subject: WebDraftSubject;
  copy: WebDraftCopy;
  offer?: WebDraftOffer;
  generatedAt: Date;
}): string {
  const { subject, copy, generatedAt } = params;
  const offer = params.offer ?? DEFAULT_WEB_DRAFT_OFFER;
  const theme = themeFor(subject.primaryType);

  const phoneBlock = subject.phone
    ? `<a class="cta" href="tel:${esc(telHref(subject.phone))}">Llamar ${esc(subject.phone)}</a>`
    : '';

  // Las reseñas van tal cual vienen de Google. Es el elemento que más
  // convence al dueño de que esto es SU web y no una plantilla genérica.
  const reviewsBlock =
    subject.rating !== null && subject.reviewCount !== null
      ? `<section class="reviews">
          <div class="stars">${'★'.repeat(Math.round(subject.rating))}</div>
          <p><strong>${subject.rating.toFixed(1)}</strong> sobre 5 ·
            ${new Intl.NumberFormat('es-ES').format(subject.reviewCount)} reseñas en Google</p>
        </section>`
      : '';

  const servicesBlock =
    copy.services.length > 0
      ? `<section class="services">
          <h2>Servicios</h2>
          <div class="grid">
            ${copy.services
              .map(
                (s) =>
                  `<article><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></article>`,
              )
              .join('')}
          </div>
        </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Es una propuesta sobre un negocio de terceros: nunca indexada. -->
<meta name="robots" content="noindex, nofollow">
<title>${esc(subject.businessName)}</title>
<style>
:root { color-scheme: light; --accent: ${theme.accent}; --accent-dark: ${theme.accentDark}; --tint: ${theme.tint}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1b1f26; line-height: 1.55; }
h1, h2, h3 { font-family: ${theme.fontHeading}; }
.wrap { max-width: 900px; margin: 0 auto; padding: 0 20px; }
header { background: var(--accent-dark); color: #fff; padding: 14px 0; }
header .wrap { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
header .brand { font-weight: 700; font-size: 17px; }
header .phone { color: #fff; text-decoration: none; font-size: 15px; }
.hero { background: var(--tint); padding: 56px 0; }
.hero h1 { font-size: 34px; margin: 0 0 12px; line-height: 1.15; }
.hero p { font-size: 18px; color: #48505c; margin: 0 0 24px; max-width: 34em; }
.cta { display: inline-block; background: var(--accent); color: #fff; text-decoration: none;
  padding: 13px 26px; border-radius: 8px; font-weight: 600; }
section { padding: 44px 0; }
section h2 { font-size: 24px; margin: 0 0 18px; }
.grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.grid article { border: 1px solid #e6e9ee; border-radius: 10px; padding: 18px; }
.grid h3 { margin: 0 0 6px; font-size: 17px; color: var(--accent-dark); }
.grid p { margin: 0; color: #55606e; font-size: 15px; }
.reviews { background: var(--tint); text-align: center; }
.reviews .stars { color: var(--accent); font-size: 26px; letter-spacing: 2px; }
.closing { background: var(--accent-dark); color: #fff; text-align: center; }
.closing h2, .closing p { color: #fff; }
footer { background: #10141a; color: #aeb7c4; font-size: 13px; padding: 26px 0; }
.banner { background: #111827; color: #fff; padding: 12px 0; font-size: 13px; }
.banner strong { color: #ffd166; }
@media (max-width: 600px) { .hero h1 { font-size: 27px; } }
</style>
</head>
<body>
<!-- Nunca se le enseña esto a un negocio sin decirle qué es. Que sea una
     propuesta y no su web publicada tiene que estar escrito en la propia
     página: el comercial lo dice por teléfono, pero el enlace se reenvía. -->
<div class="banner"><div class="wrap">
  Propuesta de Kairikos para <strong>${esc(subject.businessName)}</strong> ·
  borrador con sus datos públicos de Google, todavía no publicado
</div></div>

<header><div class="wrap">
  <span class="brand">${esc(subject.businessName)}</span>
  ${subject.phone ? `<a class="phone" href="tel:${esc(telHref(subject.phone))}">${esc(subject.phone)}</a>` : ''}
</div></header>

<div class="hero"><div class="wrap">
  <h1>${esc(copy.headline)}</h1>
  ${copy.subheadline ? `<p>${esc(copy.subheadline)}</p>` : ''}
  ${phoneBlock}
</div></div>

${copy.about ? `<section><div class="wrap"><h2>El negocio</h2><p>${esc(copy.about)}</p></div></section>` : ''}

${servicesBlock ? `<div class="wrap">${servicesBlock}</div>` : ''}

${reviewsBlock ? `<div class="wrap">${reviewsBlock}</div>` : ''}

<section class="closing"><div class="wrap">
  <h2>${esc(copy.callToAction || 'Pide cita hoy mismo')}</h2>
  ${subject.phone ? `<p style="margin-bottom:22px">${esc(subject.phone)}</p>${phoneBlock}` : ''}
</div></section>

<footer><div class="wrap">
  ${esc(subject.address ?? subject.city ?? '')}
  <p style="margin:14px 0 0">
    Borrador generado por Kairikos el ${generatedAt.toLocaleDateString('es-ES')}.
    Tu web publicada, con tus fotos y tu dominio: ${esc(offer.priceLabel)} y lista en ${esc(offer.daysLabel)}.
  </p>
</div></footer>
</body>
</html>`;
}
