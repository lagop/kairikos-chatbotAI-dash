'use client';

import { useState } from 'react';
import { annualPriceCents, annualSavingsCents, type BillingInterval } from '@/lib/annual-billing';

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
  /** Plan de precios del 01/10/2026: el escalón tiene precio anual en Stripe
   *  (12 meses por el precio de 10, sin alta). Ausente = solo mensual. */
  annualAvailable?: boolean;
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

function annualSummary(tier: SelfServeTierOption): string {
  const year = formatPrice(annualPriceCents(tier.priceCents), tier.currency);
  return `${year}/año, sin alta`;
}

/** Lo que se ahorra pagando el año: las dos mensualidades y, si la hay, el alta. */
function annualSavingsLabel(tier: SelfServeTierOption): string {
  return formatPrice(annualSavingsCents(tier.priceCents) + tier.setupFeeCents, tier.currency);
}

export function SelfServeProductCard(props: SelfServeProductCardProps) {
  const initialTierId = props.status === 'available' ? props.tiers[0]?.productId ?? '' : '';
  const [selectedProductId, setSelectedProductId] = useState<string>(
    props.status === 'available' ? initialTierId : props.productId,
  );
  const [billing, setBilling] = useState<BillingInterval>('monthly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTier = props.status === 'available' ? props.tiers.find((t) => t.productId === selectedProductId) : null;
  // El anual solo se ofrece si el escalón elegido lo tiene; al cambiar a uno
  // que no, se vuelve a mensual en vez de mandar una petición que fallaría.
  const annualOffered = Boolean(selectedTier?.annualAvailable);
  const effectiveBilling: BillingInterval = annualOffered ? billing : 'monthly';

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: selectedProductId, billing: effectiveBilling }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        if (detail?.error === 'included_in_plan') {
          setError('Tu plan de chatbot ya incluye Captación con IA: no tienes que contratarla aparte.');
        } else if (res.status === 409) {
          setError('Ya tienes este producto contratado.');
        } else if (detail?.error === 'annual_price_missing') {
          setError('El pago anual de este plan aún no está disponible. Puedes contratarlo al mes.');
        } else if (detail?.error === 'requires_chatbot') {
          setError('Necesitas el chatbot activo antes de contratar Captación con IA.');
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
            {effectiveBilling === 'annual' ? annualSummary(selectedTier) : priceSummary(selectedTier)}
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

      {props.status === 'available' && selectedTier && annualOffered ? (
        <fieldset className="space-y-1.5" data-testid="self-serve-billing">
          <legend className="sr-only">Forma de pago</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`billing-${props.code}`}
              checked={effectiveBilling === 'monthly'}
              onChange={() => setBilling('monthly')}
              data-testid="self-serve-billing-monthly"
            />
            Mensual · {priceSummary(selectedTier)}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`billing-${props.code}`}
              checked={effectiveBilling === 'annual'}
              onChange={() => setBilling('annual')}
              data-testid="self-serve-billing-annual"
            />
            <span>
              Anual · {annualSummary(selectedTier)}{' '}
              <span className="text-kairikos-accent2">(ahorras {annualSavingsLabel(selectedTier)})</span>
            </span>
          </label>
        </fieldset>
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
