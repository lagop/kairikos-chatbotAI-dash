'use client';

import { useState } from 'react';

// =============================================================================
// WP-30 — self-serve "add a product" card for /portal/productos. Two
// variants driven by `status`:
//   * 'available' — one or more Product (code+tier) rows the client can
//     buy; a <select> appears only when there's more than one tier.
//   * 'pending' — the client already started a Checkout Session for this
//     product (ClientProduct.status='pending_payment') that hasn't been
//     confirmed or abandoned yet. "Reintentar" starts a fresh session
//     against the same tier rather than assuming the client remembers
//     which one they picked.
// Both variants POST the same productId to /api/portal/billing/checkout
// and redirect the browser to the Stripe-hosted session on success.
// =============================================================================

export interface SelfServeTierOption {
  productId: string;
  tier: string;
  tierLabel: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
}

interface SelfServeProductCardBaseProps {
  code: string;
  label: string;
}

interface AvailableProps extends SelfServeProductCardBaseProps {
  status: 'available';
  tiers: SelfServeTierOption[];
}

interface PendingProps extends SelfServeProductCardBaseProps {
  status: 'pending';
  productId: string;
}

type SelfServeProductCardProps = AvailableProps | PendingProps;

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

function priceSummary(tier: SelfServeTierOption): string {
  const recurring = tier.priceCents > 0 ? `${formatPrice(tier.priceCents, tier.currency)}/mes` : null;
  const setup = tier.setupFeeCents > 0 ? `${formatPrice(tier.setupFeeCents, tier.currency)} de alta` : null;
  if (recurring && setup) return `${recurring} + ${setup}`;
  if (recurring) return recurring;
  if (setup) return `${setup} · pago único`;
  return 'Precio a confirmar';
}

export function SelfServeProductCard(props: SelfServeProductCardProps) {
  const initialTierId = props.status === 'available' ? props.tiers[0]?.productId ?? '' : '';
  const [selectedProductId, setSelectedProductId] = useState<string>(
    props.status === 'available' ? initialTierId : props.productId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTier = props.status === 'available' ? props.tiers.find((t) => t.productId === selectedProductId) : null;

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: selectedProductId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        if (res.status === 409) {
          setError('Ya tienes este producto contratado.');
        } else {
          setError(`No se pudo iniciar la contratación. ${detail?.error ?? res.statusText}`);
        }
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3" data-testid="self-serve-product-card" data-product-code={props.code} data-status={props.status}>
      <div>
        <h2 className="text-lg font-semibold">{props.label}</h2>
        {props.status === 'available' && selectedTier ? (
          <p className="mt-1 text-sm text-kairikos-muted" data-testid="self-serve-product-price">
            {priceSummary(selectedTier)}
          </p>
        ) : null}
        {props.status === 'pending' ? (
          <p className="mt-1 text-sm text-kairikos-muted">
            Pago en proceso — si no completaste el checkout o hubo un problema, puedes intentarlo de nuevo.
          </p>
        ) : null}
      </div>

      {props.status === 'available' && props.tiers.length > 1 ? (
        <select
          className="input"
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
          data-testid="self-serve-tier-select"
        >
          {props.tiers.map((t) => (
            <option key={t.productId} value={t.productId}>
              {t.tierLabel} · {priceSummary(t)}
            </option>
          ))}
        </select>
      ) : null}

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="self-serve-error">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className={props.status === 'pending' ? 'btn-ghost' : 'btn-primary'}
        onClick={startCheckout}
        disabled={busy || !selectedProductId}
        data-testid={props.status === 'pending' ? 'self-serve-retry' : 'self-serve-contract'}
      >
        {busy ? 'Redirigiendo a Stripe…' : props.status === 'pending' ? 'Reintentar pago' : 'Contratar'}
      </button>
    </div>
  );
}
