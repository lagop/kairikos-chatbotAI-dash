'use client';

import { useState } from 'react';

// =============================================================================
// Plan de precios del 01/10/2026 — comprar un pack de uso (+2.000 mensajes del
// chatbot, +100 negocios de prospección). Abre el pago de Stripe; el saldo lo
// suma el webhook cuando Stripe confirma el cobro, no la vuelta a esta página.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  pack_not_on_sale: 'Este pack todavía no está disponible. Escríbenos y lo activamos.',
  target_not_found: 'No encontramos el servicio al que añadirlo. Recarga la página.',
  stripe_not_configured: 'El pago no está disponible ahora mismo. Inténtalo en un rato.',
};

export function BuyUsagePackButton(props: {
  packCode: 'pack_chatbot_messages' | 'pack_prospecting_leads';
  /** El chatbot (o la campaña) que recibe el saldo. */
  clientProductId: string | null;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/usage-packs/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packCode: props.packCode, clientProductId: props.clientProductId }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? 'No se pudo abrir el pago. Inténtalo de nuevo.');
        setBusy(false);
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Error de red. Inténtalo de nuevo.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button type="button" className="btn-primary" onClick={buy} disabled={busy} data-testid={`buy-${props.packCode}`}>
        {busy ? 'Redirigiendo a Stripe…' : props.label}
      </button>
      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
