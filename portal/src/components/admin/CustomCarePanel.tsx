'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_TRIAL_MONTHS } from '@/lib/custom-care-rules';

// =============================================================================
// 11/11/2026 — el mantenimiento de UNA web, visto por el operador: qué tiene
// contratado, la oferta a medida pendiente y el formulario para ofrecer otra
// (lib/custom-care.ts). Ofrecer no cobra: el cliente la activa desde la
// página de su web guardando la tarjeta.
// =============================================================================

export interface CustomCarePanelData {
  /** Solo con la web pagada: hasta entonces la cuota va en el presupuesto. */
  webActive: boolean;
  contract: { status: string; customPriceCents: number | null; nextChargeAt: string | null } | null;
  offer: { clientProductId: string; priceCents: number; trialMonths: number; currency: string } | null;
  catalogPriceCents: number | null;
}

const ERROR_LABEL: Record<string, string> = {
  already_contracted: 'Esta web ya tiene el Cuidado contratado. Para cambiar la cuota, hazlo en Stripe.',
  care_product_missing: 'El Cuidado de la web no está en el catálogo.',
  web_not_found: 'La web no está activa.',
  offer_not_found: 'Esa oferta ya no está pendiente. Recarga la página.',
  invalid_body: 'Revisa el importe y los meses.',
};

function money(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

export function CustomCarePanel({ webClientProductId, data }: { webClientProductId: string; data: CustomCarePanelData }) {
  const router = useRouter();
  const [euros, setEuros] = useState('');
  const [months, setMonths] = useState('0');
  const [busy, setBusy] = useState<null | 'offer' | 'withdraw'>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(kind: 'offer' | 'withdraw', init: RequestInit) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/admin/portal/web/${webClientProductId}/custom-care`, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(ERROR_LABEL[body.error ?? ''] ?? 'No se pudo guardar.');
        return;
      }
      setEuros('');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function offer() {
    const priceCents = Math.round(parseFloat(euros) * 100);
    const trialMonths = Number(months);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      setError('La cuota tiene que ser mayor que 0. Sin mantenimiento = no ofrecer nada.');
      return;
    }
    if (!Number.isInteger(trialMonths) || trialMonths < 0 || trialMonths > MAX_TRIAL_MONTHS) {
      setError(`Los meses sin cobrar van de 0 a ${MAX_TRIAL_MONTHS}.`);
      return;
    }
    void call('offer', { method: 'POST', body: JSON.stringify({ priceCents, trialMonths }) });
  }

  return (
    <div className="card mt-3 space-y-3" data-testid="custom-care-panel">
      <header>
        <h3 className="text-base font-semibold">Mantenimiento</h3>
        <p className="mt-1 text-xs text-kairikos-muted">
          Cuidado de la web con un precio pactado. El cliente lo activa desde la página de su web guardando la tarjeta;
          Stripe cobra la primera cuota al acabar los meses sin cobrar.
        </p>
      </header>

      {data.contract ? (
        <p className="text-sm" data-testid="custom-care-contract">
          Contratado ({data.contract.status}) ·{' '}
          {data.contract.customPriceCents
            ? `${money(data.contract.customPriceCents)}/mes, precio pactado`
            : data.catalogPriceCents != null
              ? `${money(data.catalogPriceCents)}/mes, precio del catálogo`
              : 'precio del catálogo'}
          {data.contract.nextChargeAt
            ? ` · próximo cobro el ${new Date(data.contract.nextChargeAt).toLocaleDateString('es-ES')}`
            : ''}
          .
        </p>
      ) : null}

      {!data.contract && data.offer ? (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="custom-care-offer">
          <span>
            Oferta pendiente: <b>{money(data.offer.priceCents, data.offer.currency)}/mes</b>
            {data.offer.trialMonths > 0 ? `, ${data.offer.trialMonths} meses sin cobrar` : ', desde el primer mes'}. El
            cliente aún no la ha activado.
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null}
            onClick={() => void call('withdraw', { method: 'DELETE', body: JSON.stringify({ offerClientProductId: data.offer!.clientProductId }) })}
            data-testid="custom-care-withdraw"
          >
            {busy === 'withdraw' ? 'Retirando…' : 'Retirar'}
          </button>
        </div>
      ) : null}

      {!data.webActive ? (
        <p className="text-sm text-kairikos-muted">
          Se ofrece cuando la web esté pagada. Si es una web nueva, pon la cuota en el presupuesto: al pagarse, la oferta
          aparece sola.
        </p>
      ) : !data.contract ? (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor={`custom-care-price-${webClientProductId}`}>
              Cuota (EUR/mes)
            </label>
            <input
              id={`custom-care-price-${webClientProductId}`}
              type="number"
              step="0.01"
              min="0"
              className="input w-32"
              value={euros}
              onChange={(e) => setEuros(e.target.value)}
              data-testid="custom-care-price"
            />
          </div>
          <div>
            <label className="label" htmlFor={`custom-care-months-${webClientProductId}`}>
              Meses sin cobrar
            </label>
            <input
              id={`custom-care-months-${webClientProductId}`}
              type="number"
              step="1"
              min="0"
              max={MAX_TRIAL_MONTHS}
              className="input w-24"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              data-testid="custom-care-months"
            />
          </div>
          <button type="button" className="btn-primary" disabled={busy !== null || !euros.trim()} onClick={offer} data-testid="custom-care-offer-button">
            {busy === 'offer' ? 'Guardando…' : data.offer ? 'Sustituir la oferta' : 'Ofrecer al cliente'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
