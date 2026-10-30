// =============================================================================
// 26/10/2026 — de qué datos se pinta un borrador: lo guardado en el prospecto
// más lo que Google dice HOY (web-draft-live.ts).
//
// Pura y sin 'server-only' para probarla sin red. La regla de prioridad es
// una: lo de Google en vivo gana a lo guardado, porque lo guardado se copió
// el día que el barrido encontró al negocio y puede estar viejo — así salía
// «C. Violeta, 20» para un negocio que ya estaba en C. Camelia, 50. Lo
// guardado queda como respaldo cuando no hay datos en vivo (sin place ID,
// tope diario agotado, Google caído).
// =============================================================================

import type { PlaceDraftData } from './google-places';
import type { WebDraftCopy } from './web-draft-ai';
import type { WebDraftSubject } from './web-draft-html';
import { filterDraftReviews, groupOpeningHours, renderableHighlights } from './web-draft-reviews';

/** La dirección que se guardó en Lead.summary al crear el prospecto. */
export function addressFromLeadSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const address = summary
    .replace(/^Negocio encontrado en\s*/i, '')
    .replace(/\.$/, '')
    .replace(/,\s*(España|Spain)$/i, '')
    .trim();
  return address || null;
}

export function withLiveData(
  base: WebDraftSubject,
  live: PlaceDraftData | null,
  copy: Pick<WebDraftCopy, 'highlights'>,
): WebDraftSubject {
  if (!live) return base;
  const reviews = filterDraftReviews(live.reviews, base.businessName);
  return {
    ...base,
    // «…, Las Palmas, España» en la web de un negocio local sobra el país.
    address: live.formattedAddress?.replace(/,\s*(España|Spain)$/i, '') || base.address,
    phone: live.phoneNumber || base.phone,
    rating: live.rating ?? base.rating,
    reviewCount: live.userRatingCount ?? base.reviewCount,
    hours: groupOpeningHours(live.weekdayDescriptions),
    googleMapsUri: live.googleMapsUri,
    reviews,
    highlights: renderableHighlights(copy.highlights, reviews),
  };
}

/** Lo del prospecto que hace falta para pintar su borrador. */
export interface DraftLeadFields {
  contactName: string | null;
  contactPhone: string | null;
  summary: string | null;
  primaryType: string | null;
  searchLocation: string | null;
  competitorSnapshot: { subjectRating: number | null; subjectReviewCount: number | null } | null;
}

/** El sujeto de un borrador de prospecto: lo guardado más lo de Google en
 *  vivo. Lo comparten el enlace público (/borrador) y el editor del operador
 *  (web-draft-editor.ts, 30/10/2026): el operador tiene que ver al editar lo
 *  mismo que verá el prospecto. */
export function leadDraftSubject(lead: DraftLeadFields & { contactName: string }, live: PlaceDraftData | null, copy: Pick<WebDraftCopy, 'highlights'>): WebDraftSubject {
  return withLiveData(
    {
      businessName: lead.contactName,
      primaryType: lead.primaryType,
      city: lead.searchLocation,
      address: addressFromLeadSummary(lead.summary),
      phone: lead.contactPhone,
      rating: lead.competitorSnapshot?.subjectRating ?? null,
      reviewCount: lead.competitorSnapshot?.subjectReviewCount ?? null,
    },
    live,
    copy,
  );
}
