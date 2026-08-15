'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from './TotpStepUpModal';

type StripeMode = 'test' | 'live';

interface ModeCredentialStatus {
  configured: boolean;
  lastFour: string | null;
  savedAt: string | null;
}

export interface StripeCredentialStatus {
  activeMode: StripeMode | null;
  test: ModeCredentialStatus;
  live: ModeCredentialStatus;
}

export interface ProductRow {
  id: string;
  code: string;
  tier: string;
  name: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
  stripeProductId: string | null;
  stripeRecurringPriceId: string | null;
  stripeSetupPriceId: string | null;
  stripePriceMode: StripeMode | null;
}

interface PartialFailure {
  stripeProductId: string;
  stripeRecurringPriceId: string | null;
  stripeSetupPriceId: string | null;
}

type ToastKind = 'success' | 'error';
interface ToastState {
  kind: ToastKind;
  message: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Datos inválidos.',
  invalid_stripe_key: 'Stripe rechazó esa clave — revisa que la copiaste completa.',
  credential_not_configured_for_mode: 'Primero guarda una clave para ese modo.',
  already_bootstrapped: 'Este tier ya está creado en Stripe.',
  not_bootstrapped_yet: 'Este tier todavía no está creado en Stripe.',
  concurrent_modification: 'El precio cambió mientras editabas — recarga la página.',
  service_unavailable: 'No disponible en este momento.',
  stripe_error: 'Stripe devolvió un error inesperado.',
  product_not_found: 'No se encontró el producto.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
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

export function StripeCatalogSettingsPanel({
  initialCredentials,
  initialProducts,
}: {
  initialCredentials: StripeCredentialStatus;
  initialProducts: ProductRow[];
}) {
  const router = useRouter();
  const [credentials, setCredentials] = useState(initialCredentials);
  const [products, setProducts] = useState(initialProducts);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testKeyInput, setTestKeyInput] = useState('');
  const [liveKeyInput, setLiveKeyInput] = useState('');
  const [selectedMode, setSelectedMode] = useState<StripeMode | null>(initialCredentials.activeMode);
  const [stepUp, setStepUp] = useState<StepUpPending | null>(null);
  const [repriceOpenFor, setRepriceOpenFor] = useState<string | null>(null);
  const [repriceDrafts, setRepriceDrafts] = useState<Record<string, { priceEuros: string; setupFeeEuros: string }>>({});
  const [impact, setImpact] = useState<Record<string, number>>({});
  const [partialFailures, setPartialFailures] = useState<Record<string, PartialFailure>>({});

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

  async function saveCredential(mode: StripeMode) {
    const secretKey = mode === 'test' ? testKeyInput : liveKeyInput;
    if (!secretKey) return;
    await requestWithStepUp(
      `save-${mode}`,
      () =>
        fetch('/api/admin/portal/settings/stripe/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, secretKey }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: `Clave de ${mode} guardada.` });
          if (mode === 'test') setTestKeyInput('');
          else setLiveKeyInput('');
          setCredentials((c) => ({
            ...c,
            [mode]: { configured: true, lastFour: body.lastFour as string, savedAt: new Date().toISOString() },
          }));
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function switchActiveMode() {
    if (!selectedMode || selectedMode === credentials.activeMode) return;
    await requestWithStepUp(
      'active-mode',
      () =>
        fetch('/api/admin/portal/settings/stripe/active-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: selectedMode }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setCredentials((c) => ({ ...c, activeMode: selectedMode }));
          showToast({ kind: 'success', message: `Modo activo: ${selectedMode}.` });
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function bootstrapTier(product: ProductRow) {
    await requestWithStepUp(
      `bootstrap-${product.id}`,
      () => fetch(`/api/admin/portal/settings/products/${product.id}/bootstrap`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setProducts((rows) => rows.map((r) => (r.id === product.id ? { ...r, ...(body.product as object) } : r)));
          showToast({ kind: 'success', message: `${product.name}: creado en Stripe.` });
        } else if (body.error === 'partial_failure') {
          setPartialFailures((m) => ({ ...m, [product.id]: body as unknown as PartialFailure }));
          showToast({ kind: 'error', message: 'Se creó en Stripe pero no se guardó aquí — usa "Recuperar".' });
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function reconcile(productId: string) {
    const pf = partialFailures[productId];
    if (!pf) return;
    await requestWithStepUp(
      `reconcile-${productId}`,
      () =>
        fetch(`/api/admin/portal/settings/products/${productId}/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pf),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setProducts((rows) => rows.map((r) => (r.id === productId ? { ...r, ...(body.product as object) } : r)));
          setPartialFailures((m) => {
            const next = { ...m };
            delete next[productId];
            return next;
          });
          showToast({ kind: 'success', message: 'Recuperado.' });
        } else {
          showToast({ kind: 'error', message: 'No se pudo recuperar.' });
        }
      },
    );
  }

  async function loadImpact(productId: string) {
    const res = await fetch(`/api/admin/portal/settings/products/${productId}/impact`).catch(() => null);
    if (res?.ok) {
      const body = await safeJson(res);
      setImpact((m) => ({ ...m, [productId]: body.activeSubscriptions as number }));
    }
  }

  function toggleReprice(product: ProductRow) {
    setRepriceOpenFor((cur) => (cur === product.id ? null : product.id));
    setRepriceDrafts((d) => ({
      ...d,
      [product.id]: {
        priceEuros: (product.priceCents / 100).toFixed(2),
        setupFeeEuros: (product.setupFeeCents / 100).toFixed(2),
      },
    }));
    void loadImpact(product.id);
  }

  async function confirmReprice(product: ProductRow) {
    const draft = repriceDrafts[product.id];
    if (!draft) return;
    const newPriceCents = Math.round(parseFloat(draft.priceEuros) * 100);
    const newSetupFeeCents = Math.round(parseFloat(draft.setupFeeEuros) * 100);
    if (!Number.isFinite(newPriceCents) || newPriceCents < 0) {
      showToast({ kind: 'error', message: 'Precio inválido.' });
      return;
    }
    await requestWithStepUp(
      `reprice-${product.id}`,
      () =>
        fetch(`/api/admin/portal/settings/products/${product.id}/reprice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            priceCents: newPriceCents,
            setupFeeCents: Number.isFinite(newSetupFeeCents) ? newSetupFeeCents : null,
            expectedPriceCents: product.priceCents,
            expectedSetupFeeCents: product.setupFeeCents,
          }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setProducts((rows) => rows.map((r) => (r.id === product.id ? { ...r, ...(body.product as object) } : r)));
          setRepriceOpenFor(null);
          showToast({ kind: 'success', message: `${product.name}: precio actualizado.` });
        } else if (body.error === 'partial_failure') {
          setPartialFailures((m) => ({ ...m, [product.id]: body as unknown as PartialFailure }));
          showToast({ kind: 'error', message: 'Se creó en Stripe pero no se guardó aquí — usa "Recuperar".' });
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  const grouped = new Map<string, ProductRow[]>();
  for (const p of products) {
    grouped.set(p.code, [...(grouped.get(p.code) ?? []), p]);
  }

  return (
    <div className="space-y-6">
      {toast ? (
        <div
          role="status"
          data-testid="stripe-settings-toast"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      <section className="card space-y-5" aria-label="Credenciales de Stripe">
        <h2 className="text-lg font-semibold">Credenciales</h2>
        {(['test', 'live'] as const).map((mode) => {
          const status = credentials[mode];
          const value = mode === 'test' ? testKeyInput : liveKeyInput;
          const setValue = mode === 'test' ? setTestKeyInput : setLiveKeyInput;
          return (
            <div key={mode} className="space-y-2 border-t border-kairikos-border/60 pt-4 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between">
                <p className="font-semibold capitalize">{mode}</p>
                <p className="text-sm text-kairikos-muted" data-testid={`stripe-credential-status-${mode}`}>
                  {status.configured
                    ? `•••• ${status.lastFour} — guardada ${formatDate(status.savedAt)}`
                    : 'Sin configurar'}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  className="input flex-1"
                  placeholder={mode === 'test' ? 'sk_test_...' : 'sk_live_...'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  data-testid={`stripe-credential-input-${mode}`}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!value || busyKey === `save-${mode}`}
                  onClick={() => saveCredential(mode)}
                  data-testid={`stripe-credential-save-${mode}`}
                >
                  {busyKey === `save-${mode}` ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </div>
          );
        })}

        <div className="space-y-2 border-t border-kairikos-border/60 pt-4">
          <p className="label">Modo activo</p>
          <div className="flex items-center gap-4">
            {(['test', 'live'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm capitalize">
                <input
                  type="radio"
                  name="active-mode"
                  checked={selectedMode === mode}
                  disabled={!credentials[mode].configured}
                  onChange={() => setSelectedMode(mode)}
                  data-testid={`stripe-active-mode-${mode}`}
                />
                {mode}
              </label>
            ))}
            <button
              type="button"
              className="btn-ghost"
              disabled={!selectedMode || selectedMode === credentials.activeMode || busyKey === 'active-mode'}
              onClick={() => switchActiveMode()}
              data-testid="stripe-active-mode-apply"
            >
              {busyKey === 'active-mode' ? 'Aplicando…' : 'Aplicar'}
            </button>
          </div>
        </div>
      </section>

      <section className="card space-y-4" aria-label="Catálogo de productos">
        <h2 className="text-lg font-semibold">Catálogo</h2>
        {[...grouped.entries()].map(([code, rows]) => (
          <div key={code} className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{code}</p>
            {rows.map((product) => {
              const bootstrapped = Boolean(product.stripeProductId);
              const modeMismatch =
                bootstrapped &&
                credentials.activeMode !== null &&
                product.stripePriceMode !== null &&
                product.stripePriceMode !== credentials.activeMode;
              const pf = partialFailures[product.id];
              const draft = repriceDrafts[product.id];
              return (
                <div key={product.id} className="rounded-xl border border-kairikos-border/60 p-4" data-testid="stripe-catalog-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{product.name}</p>
                      <p className="text-sm text-kairikos-muted">
                        {formatPrice(product.priceCents, product.currency)}
                        {product.priceCents > 0 ? '/mes' : ''}
                        {product.setupFeeCents > 0 ? ` + ${formatPrice(product.setupFeeCents, product.currency)} de alta` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {modeMismatch ? (
                        <span className="rounded-full border border-kairikos-warning/40 bg-kairikos-warning/10 px-3 py-1 text-xs text-kairikos-warning">
                          ⚠️ creado en {product.stripePriceMode}, activo es {credentials.activeMode}
                        </span>
                      ) : bootstrapped ? (
                        <span className="rounded-full border border-kairikos-success/40 bg-kairikos-success/10 px-3 py-1 text-xs text-kairikos-success">
                          Listo
                        </span>
                      ) : (
                        <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1 text-xs text-kairikos-muted">
                          Sin bootstrap
                        </span>
                      )}
                      {!bootstrapped ? (
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busyKey === `bootstrap-${product.id}`}
                          onClick={() => bootstrapTier(product)}
                          data-testid={`stripe-bootstrap-${product.id}`}
                        >
                          {busyKey === `bootstrap-${product.id}` ? 'Creando…' : 'Crear en Stripe'}
                        </button>
                      ) : (
                        <button type="button" className="btn-ghost" onClick={() => toggleReprice(product)}>
                          {repriceOpenFor === product.id ? 'Cancelar' : 'Cambiar precio'}
                        </button>
                      )}
                    </div>
                  </div>

                  {pf ? (
                    <div className="mt-3 rounded-lg border border-kairikos-danger/40 bg-kairikos-danger/10 p-3 text-sm text-kairikos-danger">
                      <p>Se creó en Stripe pero no se guardó aquí.</p>
                      <button
                        type="button"
                        className="btn-ghost mt-2"
                        disabled={busyKey === `reconcile-${product.id}`}
                        onClick={() => reconcile(product.id)}
                        data-testid={`stripe-reconcile-${product.id}`}
                      >
                        {busyKey === `reconcile-${product.id}` ? 'Recuperando…' : 'Recuperar'}
                      </button>
                    </div>
                  ) : null}

                  {repriceOpenFor === product.id && draft ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-kairikos-border/60 bg-kairikos-surface2 p-3">
                      {impact[product.id] !== undefined ? (
                        <p className="text-xs text-kairikos-muted">
                          {impact[product.id]} cliente{impact[product.id] === 1 ? '' : 's'} activo
                          {impact[product.id] === 1 ? '' : 's'} mantiene{impact[product.id] === 1 ? '' : 'n'} su precio actual.
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label className="label" htmlFor={`price-${product.id}`}>
                            Precio mensual ({product.currency})
                          </label>
                          <input
                            id={`price-${product.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            className="input w-32"
                            value={draft.priceEuros}
                            onChange={(e) =>
                              setRepriceDrafts((d) => ({ ...d, [product.id]: { ...d[product.id], priceEuros: e.target.value } }))
                            }
                            data-testid={`stripe-reprice-price-${product.id}`}
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`setup-${product.id}`}>
                            Cuota de alta ({product.currency})
                          </label>
                          <input
                            id={`setup-${product.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            className="input w-32"
                            value={draft.setupFeeEuros}
                            onChange={(e) =>
                              setRepriceDrafts((d) => ({ ...d, [product.id]: { ...d[product.id], setupFeeEuros: e.target.value } }))
                            }
                            data-testid={`stripe-reprice-setup-${product.id}`}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busyKey === `reprice-${product.id}`}
                          onClick={() => confirmReprice(product)}
                          data-testid={`stripe-reprice-confirm-${product.id}`}
                        >
                          {busyKey === `reprice-${product.id}` ? 'Guardando…' : 'Confirmar cambio de precio'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </div>
  );
}
