import type { DraftReview, RenderHighlight } from './web-draft-reviews';

// =============================================================================
// Webs con IA, entrega 3 (27/10/2026) — el HTML de lo que viene de Google en
// el borrador: las citas («Lo que repiten sus clientes»), las reseñas y la
// atribución de Google Maps.
//
// Lo escribe el CÓDIGO y no la plantilla, por las políticas de Places: cada
// reseña lleva su autor con enlace a su perfil, cuándo la escribió, si la
// tradujo Google, y el bloque lleva el aviso de cómo se filtran y el logotipo
// de Google Maps. Si cada plantilla generada lo pintara a su manera, bastaría
// una que se olvidara del autor para incumplirlas. La plantilla solo decide
// cómo se ven estas clases (y el validador exige que les dé estilo):
//
//   citas_html   <li class="cita"><h3>…</h3><p>«…»</p><span class="cita-autor">…</span></li>
//   resenas_html <figure class="resena"><div class="resena-estrellas">★★★★★</div>
//                  <blockquote><p>…</p></blockquote><figcaption>…</figcaption></figure>
//   atribucion   <p class="atribucion-google">…</p>
//
// Puro: lo usan el borrador y los contenidos de muestra con los que se
// prueban las plantillas.
// =============================================================================

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stars(rating: number): string {
  return '★'.repeat(Math.max(1, Math.min(5, Math.round(rating))));
}

export function renderCitasHtml(highlights: ReadonlyArray<RenderHighlight>): string {
  return highlights
    .map(
      (h) =>
        `<li class="cita"><h3>${esc(h.title)}</h3><p>«${esc(h.quote)}»</p><span class="cita-autor">${esc(h.author)} · reseña de Google</span></li>`,
    )
    .join('\n');
}

export function renderResenasHtml(reviews: ReadonlyArray<DraftReview>): string {
  return reviews
    .map((r) => {
      const author = r.authorUri
        ? `<a href="${esc(r.authorUri)}" rel="noopener nofollow" target="_blank">${esc(r.author)}</a>`
        : esc(r.author);
      const meta = [r.relativeTime ? esc(r.relativeTime.toLocaleLowerCase('es-ES')) : '', 'reseña de Google', r.translated ? 'traducida por Google' : '']
        .filter(Boolean)
        .join(' · ');
      return `<figure class="resena"><div class="resena-estrellas" aria-label="${r.rating} de 5 estrellas">${stars(r.rating)}</div><blockquote><p>${esc(
        r.text,
      )}</p></blockquote><figcaption><strong>${author}</strong> · ${meta}</figcaption></figure>`;
    })
    .join('\n');
}

/** El logotipo oficial va sobre una pastilla blanca: así se lee igual sobre
 *  el fondo claro u oscuro que haya elegido la plantilla (las políticas piden
 *  el logotipo sobre fondo liso y legible). */
export function atribucionGoogleHtml(withReviewsNote: boolean): string {
  return `<p class="atribucion-google">${
    withReviewsNote ? 'Reseñas de Google de 4 y 5 estrellas, en el orden de relevancia de Google. ' : ''
  }<span style="display:inline-block;background:#fff;padding:3px 6px;border-radius:4px;vertical-align:middle"><img src="/google-maps/google-maps-logo-dark.svg" alt="Google Maps" width="98" height="18" translate="no"></span></p>`;
}

/** Lo mismo con datos inventados, para probar plantillas con las reseñas
 *  pintadas (sin esto, ninguna comprobación vería si les dan estilo). */
export const SAMPLE_DRAFT_MARKUP = {
  citasHtml: renderCitasHtml([
    { title: 'Localiza la avería rápido', quote: 'Localiza las averías muy rápido.', author: 'Cliente A.' },
    { title: 'Sin romper de más', quote: 'Tiene una máquina especial para no tener que estar rompiendo todo.', author: 'Cliente B.' },
    { title: 'Puntual y preparado', quote: 'Puntual y muy atento en las explicaciones.', author: 'Cliente C.' },
  ]),
  resenasHtml: renderResenasHtml([
    { ref: 'a', rating: 5, text: 'Muy profesional, localiza las averías muy rápido y deja todo limpio. Muy recomendable.', translated: false, author: 'Cliente A.', authorUri: null, relativeTime: 'Hace un año' },
    { ref: 'b', rating: 5, text: 'Da gusto tratar con gente responsable, puntual y muy atenta en las explicaciones.', translated: false, author: 'Cliente B.', authorUri: null, relativeTime: 'Hace 10 meses' },
    { ref: 'c', rating: 4, text: 'Buen trabajo y buen trato; volvería a llamarle.', translated: true, author: 'Cliente C.', authorUri: null, relativeTime: 'Hace 2 meses' },
  ]),
  atribucionGoogleHtml: atribucionGoogleHtml(true),
};
