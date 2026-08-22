'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from '@/components/portal/TotpStepUpModal';

export interface WebQuoteData {
  id: string;
  status: string;
  amountCents: number;
  // WebQuote v2 — optional operator-entered advance. Splits billing into
  // a deposit invoice + a final-balance invoice instead of one invoice
  // for the full amount. Null preserves the original single-payment flow.
  depositCents: number | null;
  currency: string;
  description: string;
  sentAt: string | null;
  acceptedAt: string | null;
  cancelledAt: string | null;
}

export interface WebQuoteInvoiceData {
  id: string;
  status: string;
  hostInvoiceUrl: string | null;
  paymentChannel: string | null;
  paymentReference: string | null;
}

type ToastKind = 'success' | 'error';
interface ToastState {
  kind: ToastKind;
  message: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Datos inválidos.',
  client_product_not_found: 'Este cliente no pidió presupuesto de web todavía.',
  not_quote_pending: 'Este cliente ya no está en el flujo de presupuesto.',
  quote_already_exists: 'Ya existe un presupuesto para este cliente.',
  web_quote_not_found: 'No se encontró el presupuesto.',
  quote_locked: 'El presupuesto ya no se puede editar en este estado.',
  not_accepted: 'El cliente todavía no aceptó el presupuesto.',
  not_invoiced: 'Todavía no se generó la factura.',
  not_deposit_paid: 'El adelanto todavía no está pagado.',
  not_cancelled: 'El presupuesto no está cancelado.',
  cannot_cancel: 'El presupuesto ya no se puede cancelar (facturado o pagado).',
  cannot_void: 'Esta factura ya no se puede anular.',
  invoice_not_found: 'No se encontró la factura.',
  already_paid: 'La factura ya estaba pagada.',
  service_unavailable: 'No disponible en este momento.',
  stripe_error: 'Stripe devolvió un error inesperado.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo completar la operación.';
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

interface StepUpPending {
  onVerified: () => void;
  onCancel: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  sent: 'Enviado al cliente',
  accepted: 'Aceptado por el cliente',
  invoiced: 'Facturado',
  invoiced_deposit: 'Adelanto facturado',
  deposit_paid: 'Adelanto pagado',
  invoiced_final: 'Saldo final facturado',
  paid: 'Pagado',
  cancelled: 'Cancelado',
};

const VOIDABLE_STATUSES = new Set(['invoiced', 'invoiced_deposit', 'invoiced_final']);

export function WebQuoteEditor({
  clientProductId,
  webQuote,
  invoice,
}: {
  clientProductId: string;
  webQuote: WebQuoteData | null;
  invoice: WebQuoteInvoiceData | null;
}) {
  const router = useRouter();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<StepUpPending | null>(null);
  const [editing, setEditing] = useState(!webQuote);
  const [amountEuros, setAmountEuros] = useState(webQuote ? (webQuote.amountCents / 100).toFixed(2) : '');
  const [depositEuros, setDepositEuros] = useState(
    webQuote?.depositCents != null ? (webQuote.depositCents / 100).toFixed(2) : '',
  );
  const [description, setDescription] = useState(webQuote?.description ?? '');
  const [channel, setChannel] = useState<'transfer' | 'cash'>('transfer');
  const [reference, setReference] = useState('');

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 5000);
  };

  async function requestWithStepUp(
    key: string,
    doFetch: () => Promise<Response>,
    onDone: (res: Response) => Promise<void> | void,
  ) {
    setBusyKey(key);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const body = await res.clone().json().catch(() => ({}));
        if ((body as { error?: string }).error === 'totp_step_up_required') {
          setStepUp({
            onVerified: () => {
              setStepUp(null);
              void requestWithStepUp(key, doFetch, onDone);
            },
            onCancel: () => setStepUp(null),
          });
          return;
        }
      }
      await onDone(res);
    } finally {
      setBusyKey(null);
    }
  }

  async function saveDraft() {
    const amountCents = Math.round(parseFloat(amountEuros) * 100);
    const depositCents = depositEuros.trim() ? Math.round(parseFloat(depositEuros) * 100) : null;
    if (!Number.isFinite(amountCents) || amountCents < 0 || !description.trim()) {
      showToast({ kind: 'error', message: 'Completa el monto y la descripción.' });
      return;
    }
    if (depositCents !== null && (!Number.isFinite(depositCents) || depositCents <= 0 || depositCents >= amountCents)) {
      showToast({ kind: 'error', message: 'El adelanto debe ser mayor a 0 y menor al monto total.' });
      return;
    }
    setBusyKey('save');
    try {
      const res = webQuote
        ? await fetch(`/api/admin/portal/web-quotes/${webQuote.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amountCents, depositCents, description }),
          })
        : await fetch('/api/admin/portal/web-quotes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientProductId, amountCents, ...(depositCents !== null ? { depositCents } : {}), description }),
          });
      const body = await safeJson(res);
      if (res.ok) {
        showToast({ kind: 'success', message: 'Borrador guardado.' });
        router.refresh();
      } else {
        showToast({ kind: 'error', message: errorLabel(body.error as string) });
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function sendQuote() {
    if (!webQuote) return;
    await requestWithStepUp(
      'send',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/send`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Presupuesto enviado al cliente.' });
          setEditing(false);
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function cancelQuote() {
    if (!webQuote) return;
    await requestWithStepUp(
      'cancel',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/cancel`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Presupuesto cancelado.' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function resetQuote() {
    if (!webQuote) return;
    await requestWithStepUp(
      'reset',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/reset`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Presupuesto reiniciado — podés editarlo de nuevo.' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function generateInvoice() {
    if (!webQuote) return;
    await requestWithStepUp(
      'generate-invoice',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/generate-invoice`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Factura generada.' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function generateFinalInvoice() {
    if (!webQuote) return;
    await requestWithStepUp(
      'generate-final-invoice',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/generate-final-invoice`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Factura del saldo final generada.' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function voidInvoice() {
    if (!webQuote) return;
    await requestWithStepUp(
      'void-invoice',
      () => fetch(`/api/admin/portal/web-quotes/${webQuote.id}/void-invoice`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Factura anulada — el presupuesto quedó cancelado.' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function markPaid() {
    if (!webQuote || !reference.trim()) {
      showToast({ kind: 'error', message: 'Indica una referencia del pago.' });
      return;
    }
    await requestWithStepUp(
      'mark-paid',
      () =>
        fetch(`/api/admin/portal/web-quotes/${webQuote.id}/mark-paid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, reference }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Marcado como pagado — confirmando con Stripe…' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  const status = webQuote?.status ?? 'none';

  return (
    <section className="card space-y-4" aria-label="Presupuesto de web" data-testid="web-quote-editor">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Presupuesto</h2>
        {webQuote ? (
          <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1 text-xs text-kairikos-muted">
            {STATUS_LABEL[status] ?? status}
          </span>
        ) : null}
      </div>

      {toast ? (
        <div
          role="status"
          data-testid="web-quote-toast"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="web-quote-amount">
              Monto (EUR)
            </label>
            <input
              id="web-quote-amount"
              type="number"
              step="0.01"
              min="0"
              className="input w-40"
              value={amountEuros}
              onChange={(e) => setAmountEuros(e.target.value)}
              data-testid="web-quote-amount-input"
            />
          </div>
          <div>
            <label className="label" htmlFor="web-quote-deposit">
              Adelanto (EUR, opcional)
            </label>
            <input
              id="web-quote-deposit"
              type="number"
              step="0.01"
              min="0"
              className="input w-40"
              placeholder="Sin adelanto"
              value={depositEuros}
              onChange={(e) => setDepositEuros(e.target.value)}
              data-testid="web-quote-deposit-input"
            />
            {depositEuros.trim() && Number.isFinite(parseFloat(amountEuros)) && Number.isFinite(parseFloat(depositEuros)) ? (
              <p className="mt-1 text-xs text-kairikos-muted" data-testid="web-quote-final-preview">
                Saldo final: {formatPrice(Math.round((parseFloat(amountEuros) - parseFloat(depositEuros)) * 100), 'eur')}
              </p>
            ) : null}
          </div>
          <div>
            <label className="label" htmlFor="web-quote-description">
              Qué incluye (el cliente lo ve tal cual)
            </label>
            <textarea
              id="web-quote-description"
              className="input min-h-[100px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="web-quote-description-input"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={busyKey === 'save'}
              onClick={saveDraft}
              data-testid="web-quote-save-draft"
            >
              {busyKey === 'save' ? 'Guardando…' : 'Guardar borrador'}
            </button>
            {webQuote ? (
              <button
                type="button"
                className="btn-primary"
                disabled={busyKey === 'send'}
                onClick={sendQuote}
                data-testid="web-quote-send"
              >
                {busyKey === 'send' ? 'Enviando…' : 'Enviar al cliente'}
              </button>
            ) : null}
          </div>
        </div>
      ) : webQuote ? (
        <div className="space-y-3">
          <div>
            <p className="text-2xl font-semibold">{formatPrice(webQuote.amountCents, webQuote.currency)}</p>
            <p className="mt-1 text-sm text-kairikos-muted">{webQuote.description}</p>
            {webQuote.depositCents != null ? (
              <p className="mt-1 text-xs text-kairikos-muted" data-testid="web-quote-deposit-breakdown">
                Adelanto: {formatPrice(webQuote.depositCents, webQuote.currency)} · Saldo final:{' '}
                {formatPrice(webQuote.amountCents - webQuote.depositCents, webQuote.currency)}
              </p>
            ) : null}
          </div>

          {status === 'cancelled' ? (
            <div className="rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 text-sm">
              <p className="text-kairikos-muted">Cancelado el {formatDate(webQuote.cancelledAt)}.</p>
              <button
                type="button"
                className="btn-ghost mt-2"
                disabled={busyKey === 'reset'}
                onClick={resetQuote}
                data-testid="web-quote-reset"
              >
                {busyKey === 'reset' ? 'Reiniciando…' : 'Reiniciar'}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(status === 'draft' || status === 'sent') ? (
                <button type="button" className="btn-ghost" onClick={() => setEditing(true)} data-testid="web-quote-edit">
                  Editar
                </button>
              ) : null}
              {status === 'draft' || status === 'sent' ? (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busyKey === 'send'}
                  onClick={sendQuote}
                  data-testid="web-quote-send"
                >
                  {busyKey === 'send' ? 'Enviando…' : status === 'sent' ? 'Reenviar' : 'Enviar al cliente'}
                </button>
              ) : null}
              {status === 'accepted' ? (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busyKey === 'generate-invoice'}
                  onClick={generateInvoice}
                  data-testid="web-quote-generate-invoice"
                >
                  {busyKey === 'generate-invoice'
                    ? 'Generando…'
                    : webQuote.depositCents != null
                      ? 'Generar factura del adelanto'
                      : 'Generar factura'}
                </button>
              ) : null}
              {status === 'deposit_paid' ? (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busyKey === 'generate-final-invoice'}
                  onClick={generateFinalInvoice}
                  data-testid="web-quote-generate-final-invoice"
                >
                  {busyKey === 'generate-final-invoice' ? 'Generando…' : 'Generar factura final'}
                </button>
              ) : null}
              {status === 'draft' || status === 'sent' || status === 'accepted' ? (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busyKey === 'cancel'}
                  onClick={cancelQuote}
                  data-testid="web-quote-cancel"
                >
                  {busyKey === 'cancel' ? 'Cancelando…' : 'Cancelar presupuesto'}
                </button>
              ) : null}
              {VOIDABLE_STATUSES.has(status) ? (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busyKey === 'void-invoice'}
                  onClick={voidInvoice}
                  data-testid="web-quote-void-invoice"
                >
                  {busyKey === 'void-invoice' ? 'Anulando…' : 'Anular factura'}
                </button>
              ) : null}
            </div>
          )}

          {VOIDABLE_STATUSES.has(status) && invoice ? (
            <div className="space-y-3 rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3">
              {invoice.hostInvoiceUrl ? (
                <a href={invoice.hostInvoiceUrl} target="_blank" rel="noreferrer" className="text-sm text-kairikos-accent2 underline">
                  Ver factura en Stripe →
                </a>
              ) : null}
              <p className="text-sm font-semibold">
                Marcar{' '}
                {status === 'invoiced_deposit' ? 'el adelanto' : status === 'invoiced_final' ? 'el saldo final' : ''} como
                pagada por transferencia o efectivo
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="label" htmlFor="web-quote-channel">
                    Canal
                  </label>
                  <select
                    id="web-quote-channel"
                    className="input"
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as 'transfer' | 'cash')}
                    data-testid="web-quote-channel-select"
                  >
                    <option value="transfer">Transferencia</option>
                    <option value="cash">Efectivo</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="web-quote-reference">
                    Referencia
                  </label>
                  <input
                    id="web-quote-reference"
                    type="text"
                    className="input"
                    placeholder="Nº de transferencia, nota de caja…"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    data-testid="web-quote-reference-input"
                  />
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busyKey === 'mark-paid'}
                  onClick={markPaid}
                  data-testid="web-quote-mark-paid"
                >
                  {busyKey === 'mark-paid' ? 'Marcando…' : 'Marcar como pagada'}
                </button>
              </div>
            </div>
          ) : null}

          {status === 'deposit_paid' ? (
            <p className="text-sm text-kairikos-muted" data-testid="web-quote-deposit-paid-note">
              Adelanto pagado ✓ — listo para generar la factura del saldo final.
            </p>
          ) : null}

          {status === 'paid' && invoice?.paymentChannel ? (
            <p className="text-sm text-kairikos-muted">
              Pagado por {invoice.paymentChannel === 'stripe' ? 'Stripe' : invoice.paymentChannel === 'transfer' ? 'transferencia' : 'efectivo'}
              {invoice.paymentReference ? ` — ref. ${invoice.paymentReference}` : ''}.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-kairikos-muted" data-testid="web-quote-client-product-id">
        ClientProduct: {clientProductId}
      </p>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </section>
  );
}
