'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// =============================================================================
// WebQuote Fase 4 — replaces the fixed-price SelfServeProductCard for
// 'web' on /portal/productos. The 'web' product no longer has a single
// price to charge (each project gets a custom quote), so this is a
// single free action: request a quote. Creates ClientProduct('web') in
// 'quote_pending' via POST /api/portal/web-quote/request, then sends
// the client to /portal/web where the brief + WebQuoteCard live.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  already_requested: 'Ya tienes una solicitud de presupuesto en curso.',
  product_not_found: 'Este producto no está disponible ahora mismo.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
};

export function RequestWebQuoteCard({ label }: { label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestQuote() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/web-quote/request', { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo solicitar el presupuesto.');
        setBusy(false);
        return;
      }
      // This card now renders both on /portal/productos (needs a real
      // cross-page navigation) and on /portal/web's own "not requested
      // yet" pitch (WebQuote v2 sidebar work). push()ing to the current
      // URL is a same-pathname no-op in the App Router — it never
      // remounts this component, leaving it stuck on "Solicitando…"
      // forever even though the request succeeded — and calling
      // refresh() and push() together races two competing RSC fetches,
      // where push()'s aborts refresh()'s before it applies. So: when
      // already on /portal/web, just refresh (the page stops rendering
      // this card once hasWeb flips true); otherwise navigate there.
      if (pathname === '/portal/web') {
        router.refresh();
      } else {
        router.push('/portal/web');
      }
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3" data-testid="request-web-quote-card" data-product-code="web">
      <div>
        <h2 className="text-lg font-semibold">{label}</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          El precio depende del proyecto. Cuéntanos qué necesitas y te enviamos un presupuesto a medida — sin
          compromiso.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="request-web-quote-error">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="btn-primary"
        onClick={requestQuote}
        disabled={busy}
        data-testid="request-web-quote-button"
      >
        {busy ? 'Solicitando…' : 'Solicitar presupuesto'}
      </button>
    </div>
  );
}
