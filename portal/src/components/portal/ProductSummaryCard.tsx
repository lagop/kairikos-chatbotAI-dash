import Link from 'next/link';
import type { ProductCardSummary } from '@/lib/dashboard-data';

// =============================================================================
// WP-17 — one card per contracted ClientProduct for the multi-product
// summary screen (/portal). Deliberately separate from ChatbotStatusCard
// (which stays chatbot-specific — spaceId, conversations, fallback/
// escalation rates make no sense for a product with no bot). This card
// is the generic shell every product gets: state, progress, and —
// per the AC — whose move it is, in plain words, not just a status pill
// a client has to interpret.
// =============================================================================

function TurnBadge({ turn }: { turn: ProductCardSummary['turn'] }) {
  if (turn === 'client') {
    return (
      <span className="pill-warning" data-testid="product-turn" data-turn="client">
        Te toca a ti
      </span>
    );
  }
  if (turn === 'kairikos') {
    return (
      <span className="pill-muted" data-testid="product-turn" data-turn="kairikos">
        En manos de Kairikos
      </span>
    );
  }
  return null;
}

export function ProductSummaryCard({ product }: { product: ProductCardSummary }) {
  return (
    <div className="card space-y-3" data-testid="product-summary-card" data-product-code={product.productCode}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            {product.label}
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            {product.onboardingState === 'live' ? 'En producción' : product.progressPercent !== null ? 'Configurando' : 'Próximamente'}
          </h2>
        </div>
        <TurnBadge turn={product.turn} />
      </div>

      {product.progressPercent !== null ? (
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-kairikos-border/60">
            <div
              className="h-full rounded-full bg-kairikos-accent"
              style={{ width: `${product.progressPercent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-kairikos-muted">{product.progressPercent}% configurado</p>
        </div>
      ) : null}

      {product.ctaHref ? (
        <Link href={product.ctaHref} className="btn-primary inline-block" data-testid="product-cta">
          {product.ctaLabel}
        </Link>
      ) : (
        <p className="text-sm text-kairikos-muted" data-testid="product-cta-label">
          {product.ctaLabel}
        </p>
      )}
    </div>
  );
}
