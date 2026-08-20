import 'server-only';

// =============================================================================
// WP-XX — shared status-transition rules for Lead ("Captación con IA").
// Route handlers stay thin; this is where "is this transition allowed"
// lives so it can't drift between the internal ingestion route and the
// client-facing PATCH route. Mirrors src/lib/web-quotes.ts's shape.
//
// 'server-only' — client components must NOT import this file. They
// replicate the same string comparisons inline instead, same split
// WebQuoteEditor.tsx already uses for web-quotes.ts's predicates.
// =============================================================================

/** nuevo -> contactado */
export function canMarkContacted(status: string): boolean {
  return status === 'nuevo';
}

/** contactado -> convertido */
export function canMarkConverted(status: string): boolean {
  return status === 'contactado';
}

/** Side-exit, reachable from nuevo or contactado — mirrors WebQuote's 'cancelled'. */
export function canDiscard(status: string): boolean {
  return status === 'nuevo' || status === 'contactado';
}
