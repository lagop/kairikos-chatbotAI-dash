'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface ClientWebQuoteData {
  status: string;
  amountCents: number;
  currency: string;
  description: string;
}

export interface ClientWebQuoteInvoiceData {
  hostInvoiceUrl: string | null;
}

// =============================================================================
// WebQuote Fase 4 — client-facing status card for /portal/web, rendered
// above the (unchanged) WebBrief form/summary whenever
// ClientProduct('web').status === 'quote_pending'. Mirrors the
// operator's WebQuoteEditor state machine but read-only except for the
// single "Aceptar presupuesto" action available in 'sent'.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  not_sent: 'Este presupuesto ya no está disponible para aceptar — actualiza la página.',
  web_quote_not_found: 'No se encontró el presupuesto — actualiza la página.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
};

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

export function WebQuoteCard({
  webQuote,
  invoice,
}: {
  webQuote: ClientWebQuoteData | null;
  invoice: ClientWebQuoteInvoiceData | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/web-quote/accept', { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo aceptar el presupuesto.');
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  const status = webQuote && webQuote.status !== 'cancelled' ? webQuote.status : 'waiting';

  return (
    <section className="card space-y-3" aria-label="Estado del presupuesto" data-testid="web-quote-card" data-status={status}>
      <h2 className="text-lg font-semibold">Presupuesto</h2>

      {status === 'waiting' || status === 'draft' ? (
        <p className="text-sm text-kairikos-muted" data-testid="web-quote-card-waiting">
          Estamos preparando tu presupuesto a medida — te avisaremos aquí en cuanto esté listo.
        </p>
      ) : null}

      {status === 'sent' && webQuote ? (
        <>
          <p className="text-2xl font-semibold">{formatPrice(webQuote.amountCents, webQuote.currency)}</p>
          <p className="text-sm text-kairikos-text">{webQuote.description}</p>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="web-quote-card-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            onClick={accept}
            disabled={busy}
            data-testid="web-quote-card-accept"
          >
            {busy ? 'Aceptando…' : 'Aceptar presupuesto'}
          </button>
        </>
      ) : null}

      {status === 'accepted' ? (
        <p className="text-sm text-kairikos-muted" data-testid="web-quote-card-accepted">
          Presupuesto aceptado — estamos preparando tu factura.
        </p>
      ) : null}

      {status === 'invoiced' && webQuote ? (
        <>
          <p className="text-2xl font-semibold">{formatPrice(webQuote.amountCents, webQuote.currency)}</p>
          <p className="text-sm text-kairikos-text">{webQuote.description}</p>
          {invoice?.hostInvoiceUrl ? (
            <a href={invoice.hostInvoiceUrl} target="_blank" rel="noreferrer" className="btn-primary inline-block" data-testid="web-quote-card-pay-link">
              Pagar factura →
            </a>
          ) : null}
          <p className="text-xs text-kairikos-muted">
            ¿Prefieres pagar por transferencia o efectivo?{' '}
            <a href="/portal/support" className="underline hover:text-kairikos-text">
              Contáctanos
            </a>
            .
          </p>
        </>
      ) : null}

      {status === 'paid' ? (
        <p className="text-sm text-kairikos-muted" data-testid="web-quote-card-paid">
          Pago recibido — estamos activando tu cuenta.
        </p>
      ) : null}
    </section>
  );
}
