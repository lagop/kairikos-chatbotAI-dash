'use client';

import { useState } from 'react';
import { firstChargeDate } from '@/lib/custom-care-rules';

// =============================================================================
// Plan de precios del 01/10/2026 — Cuidado de la web: alojamiento, dominio,
// copias y cambios pequeños. Se contrata desde la página de SU web, porque
// va por web (lib/web-care.ts).
// =============================================================================

export interface WebCareCardProps {
  webClientProductId: string;
  offer: { priceCents: number; annualPriceCents: number | null; currency: string } | null;
  contract: {
    status: string;
    billingInterval: string | null;
    /** El precio pactado, si es un mantenimiento a medida. */
    customPriceCents?: number | null;
    nextChargeAt?: string | null;
  } | null;
  /** 11/11/2026 — mantenimiento a medida que el cliente aún no ha activado
   *  (lib/custom-care.ts). Si lo hay, se enseña esto y no la oferta del catálogo. */
  customOffer?: { priceCents: number; trialMonths: number; currency: string } | null;
  /** ?checkout=success|cancelled de la vuelta de Stripe. */
  checkoutReturn: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  already_contracted: 'Esta web ya tiene el Cuidado contratado.',
  care_not_on_sale: 'El Cuidado de la web todavía no está disponible. Escríbenos y lo activamos.',
  annual_price_missing: 'El pago anual aún no está disponible. Puedes contratarlo al mes.',
  web_not_found: 'Tu web tiene que estar activa para contratar el Cuidado.',
  offer_not_found: 'Esta propuesta ya no está disponible. Actualiza la página.',
};

function longDate(d: Date): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

export function WebCareCard(props: WebCareCardProps) {
  const [busy, setBusy] = useState<null | 'monthly' | 'annual' | 'custom'>(null);
  const [error, setError] = useState<string | null>(null);

  async function contract(billing: 'monthly' | 'annual' | 'custom') {
    setBusy(billing);
    setError(null);
    try {
      const res = await fetch(`/api/portal/web/${props.webClientProductId}/care/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billing === 'custom' ? {} : { billing }),
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
            : `Activo${props.contract.billingInterval === 'year' ? ', con pago anual' : ''}${
                props.contract.customPriceCents ? ` · ${money(props.contract.customPriceCents, 'EUR')}/mes` : ''
              }. Nos ocupamos del alojamiento, el dominio, las copias y los cambios pequeños: pídenoslos desde Soporte.`}
        </p>
        {props.contract.customPriceCents && props.contract.nextChargeAt ? (
          <p className="text-xs text-kairikos-muted" data-testid="web-care-next-charge">
            Próximo cobro: {longDate(new Date(props.contract.nextChargeAt))}.
          </p>
        ) : null}
      </section>
    );
  }

  // 11/11/2026 — mantenimiento a medida: el precio que pactamos con este
  // cliente, en vez del de catálogo. Se activa guardando la tarjeta; Stripe
  // cobra la primera cuota al acabar los meses incluidos.
  if (props.customOffer) {
    const o = props.customOffer;
    const first = o.trialMonths > 0 ? firstChargeDate(new Date(), o.trialMonths) : null;
    return (
      <section className="card space-y-3" aria-label="Mantenimiento de la web" data-testid="web-care-card" data-state="custom-offer">
        <div>
          <p className="text-sm font-semibold">Mantenimiento de tu web · {money(o.priceCents, o.currency)}/mes</p>
          <p className="mt-0.5 text-sm text-kairikos-muted">
            El que acordamos contigo: alojamiento, dominio, copias de seguridad y los cambios que pactamos.{' '}
            {first
              ? `Guarda tu tarjeta para activarlo. Hoy no se te cobra nada: la primera cuota llega el ${longDate(first)}, y después cada mes.`
              : 'Guarda tu tarjeta para activarlo. La primera cuota se cobra hoy, y después cada mes.'}{' '}
            Sin permanencia.
          </p>
        </div>
        {props.checkoutReturn === 'success' ? (
          <p className="text-sm text-kairikos-accent2" role="status">
            Tarjeta guardada. Lo verás activo aquí en cuanto Stripe lo confirme, normalmente en unos segundos.
          </p>
        ) : null}
        <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => contract('custom')} data-testid="web-care-custom">
          {busy === 'custom' ? 'Redirigiendo a Stripe…' : 'Activar el mantenimiento'}
        </button>
        {error ? (
          <p className="text-sm text-kairikos-danger" role="alert">
            {error}
          </p>
        ) : null}
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
