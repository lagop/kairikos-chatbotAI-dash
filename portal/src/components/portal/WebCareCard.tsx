'use client';

import { useState } from 'react';

// =============================================================================
// Plan de precios del 01/10/2026 — Cuidado de la web: alojamiento, dominio,
// copias y cambios pequeños. Se contrata desde la página de SU web, porque
// va por web (lib/web-care.ts).
// =============================================================================

export interface WebCareCardProps {
  webClientProductId: string;
  offer: { priceCents: number; annualPriceCents: number | null; currency: string } | null;
  contract: { status: string; billingInterval: string | null } | null;
  /** ?checkout=success|cancelled de la vuelta de Stripe. */
  checkoutReturn: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  already_contracted: 'Esta web ya tiene el Cuidado contratado.',
  care_not_on_sale: 'El Cuidado de la web todavía no está disponible. Escríbenos y lo activamos.',
  annual_price_missing: 'El pago anual aún no está disponible. Puedes contratarlo al mes.',
  web_not_found: 'Tu web tiene que estar activa para contratar el Cuidado.',
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

export function WebCareCard(props: WebCareCardProps) {
  const [busy, setBusy] = useState<null | 'monthly' | 'annual'>(null);
  const [error, setError] = useState<string | null>(null);

  async function contract(billing: 'monthly' | 'annual') {
    setBusy(billing);
    setError(null);
    try {
      const res = await fetch(`/api/portal/web/${props.webClientProductId}/care/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billing }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? 'No se pudo abrir el pago. Inténtalo de nuevo.');
        setBusy(null);
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Error de red. Inténtalo de nuevo.');
      setBusy(null);
    }
  }

  if (props.contract) {
    return (
      <section className="card space-y-1" aria-label="Cuidado de la web" data-testid="web-care-card" data-state="contracted">
        <p className="text-sm font-semibold">Cuidado de la web</p>
        <p className="text-sm text-kairikos-muted">
          {props.contract.status === 'paused'
            ? 'En pausa.'
            : `Activo${props.contract.billingInterval === 'year' ? ', con pago anual' : ''}. Nos ocupamos del alojamiento, el dominio, las copias y los cambios pequeños: pídenoslos desde Soporte.`}
        </p>
      </section>
    );
  }

  if (!props.offer) return null;

  return (
    <section className="card space-y-3" aria-label="Cuidado de la web" data-testid="web-care-card" data-state="offer">
      <div>
        <p className="text-sm font-semibold">Cuidado de la web</p>
        <p className="mt-0.5 text-sm text-kairikos-muted">
          Alojamiento, dominio, copias de seguridad y cambios pequeños. El primer año de alojamiento y dominio ya va
          incluido con tu web; el Cuidado lo mantiene después, o desde ya si quieres poder pedirnos cambios.
        </p>
      </div>
      {props.checkoutReturn === 'success' ? (
        <p className="text-sm text-kairikos-accent2" role="status">
          Pago recibido. Lo verás activo aquí en cuanto Stripe lo confirme, normalmente en unos segundos.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => contract('monthly')} data-testid="web-care-monthly">
          {busy === 'monthly' ? 'Redirigiendo a Stripe…' : `Contratar · ${money(props.offer.priceCents, props.offer.currency)}/mes`}
        </button>
        {props.offer.annualPriceCents ? (
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => contract('annual')} data-testid="web-care-annual">
            {busy === 'annual' ? 'Redirigiendo a Stripe…' : `o ${money(props.offer.annualPriceCents, props.offer.currency)}/año`}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
