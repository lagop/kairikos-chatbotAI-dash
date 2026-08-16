import type { ReactNode } from 'react';

// =============================================================================
// Shared shell for a product's "not contracted yet" descriptive page —
// used by /portal/web and /portal/leads so a client landing there from
// the sidebar sees what the product actually includes (not just a
// generic "not included in your plan" empty state). Deliberately NOT a
// .card itself — the actual CTA (RequestWebQuoteCard, SelfServeProductCard)
// is already its own card, so this stays plain content above it instead
// of nesting card-in-card.
// =============================================================================

export function ProductPitch({
  tagline,
  features,
  priceNote,
  children,
}: {
  tagline: string;
  features: readonly string[];
  priceNote?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5" data-testid="product-pitch">
      <p className="text-base text-kairikos-text">{tagline}</p>
      <ul className="space-y-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-kairikos-text">
            <span aria-hidden className="mt-0.5 text-kairikos-accent">
              ✓
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {priceNote ? <p className="text-xs text-kairikos-muted">{priceNote}</p> : null}
      <div className="max-w-md">{children}</div>
    </div>
  );
}
