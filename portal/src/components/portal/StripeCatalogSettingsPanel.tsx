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
  /** False means the product exists in the catalogue but is not on
   *  sale. It still belongs here: Stripe prices have to be created
   *  before it goes live, not after. */
  isActive: boolean;
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
  no_mode_mismatch: 'Ya coincide con el modo activo — nada que reiniciar.',
  concurrent_modification: 'El precio cambió mientras editabas — recarga la página.',
  service_unavailable: 'No disponible en este momento.',
  stripe_error: 'Stripe devolvió un error inesperado.',
  product_not_found: 'No se encontró el producto.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  // A server-side crash (e.g. a missing encryption key) — distinct from
  // the generic fallback below so a real bug reads as a configuration
  // problem rather than the vague catch-all wording.
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
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

/**
 * A tier is mismatched when it was created on Stripe under a mode that no
 * longer matches the operator's active credential. `stripePriceMode: null`
 * (never recorded, or reconciled after a partial failure) is UNKNOWN, not
 * mismatched — claiming otherwise would offer to sever a working pointer
 * for no reason. Shared by the per-row badge and the bulk action so the
 * two can never disagree on which tiers need a reset.
 */
function isModeMismatch(product: ProductRow, activeMode: StripeMode | null): boolean {
  return (
    Boolean(product.stripeProductId) &&
    activeMode !== null &&
    product.stripePriceMode !== null &&
    product.stripePriceMode !== activeMode
  );
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
  const [bulkResetBusy, setBulkResetBusy] = useState(false);

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 5000);
  };

  /**
   * Resolves with { cancelled: true } if the operator dismisses the
   * step-up modal instead of completing it, rather than resolving as
   * soon as the modal appears — a bulk caller looping over several
   * mutations needs to know whether to stop, not just that a fetch
   * happened. Existing single-mutation callers ignore the return value,
   * so this is purely additive for them.
   */
  async function requestWithStepUp(
    key: string,
    doFetch: () => Promise<Response>,
    onDone: (res: Response) => Promise<void> | void,
  ): Promise<{ cancelled: boolean }> {
    setBusyKey(key);
    let res: Response;
    try {
      res = await doFetch();
    } finally {
      setBusyKey(null);
    }
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => ({}));
      if ((body as { error?: string }).error === 'totp_step_up_required') {
        return new Promise<{ cancelled: boolean }>((resolve) => {
          setStepUp({
            onVerified: () => {
              setStepUp(null);
              void requestWithStepUp(key, doFetch, onDone).then(resolve);
            },
            onCancel: () => {
              setStepUp(null);
              resolve({ cancelled: true });
            },
          });
        });
      }
    }
    await onDone(res);
    return { cancelled: false };
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
    // Pre-bootstrap there is no Stripe object yet, so there cannot be a
    // subscriber on the current price to protect — nothing to load.
    if (product.stripeProductId) void loadImpact(product.id);
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

  /**
   * The pre-bootstrap sibling of confirmReprice: writes straight to the
   * Product row, no Stripe call and no subscriber-impact figure (nothing
   * can be subscribed to a tier that has never existed on Stripe).
   * Whatever is saved here is exactly what Bootstrap creates the Stripe
   * Price objects WITH.
   */
  async function confirmDraftPrice(product: ProductRow) {
    const draft = repriceDrafts[product.id];
    if (!draft) return;
    const newPriceCents = Math.round(parseFloat(draft.priceEuros) * 100);
    const newSetupFeeCents = Math.round(parseFloat(draft.setupFeeEuros) * 100);
    if (!Number.isFinite(newPriceCents) || newPriceCents < 0) {
      showToast({ kind: 'error', message: 'Precio inválido.' });
      return;
    }
    if (!Number.isFinite(newSetupFeeCents) || newSetupFeeCents < 0) {
      showToast({ kind: 'error', message: 'Cuota de alta inválida.' });
      return;
    }
    await requestWithStepUp(
      `draft-price-${product.id}`,
      () =>
        fetch(`/api/admin/portal/settings/products/${product.id}/draft-price`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            priceCents: newPriceCents,
            setupFeeCents: newSetupFeeCents,
            expectedPriceCents: product.priceCents,
            expectedSetupFeeCents: product.setupFeeCents,
          }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setProducts((rows) => rows.map((r) => (r.id === product.id ? { ...r, ...(body.product as object) } : r)));
          setRepriceOpenFor(null);
          showToast({ kind: 'success', message: `${product.name}: precio guardado.` });
        } else if (body.error === 'concurrent_modification') {
          showToast({ kind: 'error', message: errorLabel('concurrent_modification') });
          router.refresh();
        } else if (body.error === 'already_bootstrapped') {
          // Someone else ran Bootstrap in the meantime — this row is
          // stale. Refresh so the button set matches reality instead of
          // offering an edit path that no longer applies.
          showToast({ kind: 'error', message: 'Ya se creó en Stripe mientras editabas — usa "Cambiar precio".' });
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  /**
   * Clears the stored Stripe pointer on a tier whose stripePriceMode no
   * longer matches the active credential, so Bootstrap reopens for it —
   * the only way forward, since test/live are separate Stripe
   * namespaces and there is no migrate-in-place. See
   * resetForModeMismatch for the full reasoning and the
   * zero-active-subscribers safety check.
   */
  async function resetModeMismatch(product: ProductRow) {
    await requestWithStepUp(
      `reset-mode-${product.id}`,
      () => fetch(`/api/admin/portal/settings/products/${product.id}/reset-mode`, { method: 'POST' }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          setProducts((rows) => rows.map((r) => (r.id === product.id ? { ...r, ...(body.product as object) } : r)));
          showToast({
            kind: 'success',
            message: `${product.name}: listo para crear de nuevo en ${credentials.activeMode}.`,
          });
        } else if (body.error === 'has_active_subscriptions') {
          // Should not happen in practice — nobody pays with a test
          // key — but this is exactly the case the count exists to
          // catch.
          const count = body.count as number;
          showToast({
            kind: 'error',
            message: `${count} cliente${count === 1 ? '' : 's'} activo${count === 1 ? '' : 's'} en este precio — no se puede reiniciar.`,
          });
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
          router.refresh();
        }
      },
    );
  }

  /**
   * The bulk counterpart of resetModeMismatch: same route, same
   * one-at-a-time safety checks (has_active_subscriptions still blocks
   * each tier individually), just looped instead of clicked N times.
   * Sequential, not parallel — the FIRST request is the one that may
   * need TOTP step-up, and step-up is a session-level flag (see
   * operator-totp-stepup.ts), so once it clears, the rest of the batch
   * sails through without re-prompting. If the operator dismisses the
   * modal, the whole batch stops rather than re-prompting per tier.
   */
  async function resetAllMismatched() {
    if (bulkResetBusy) return;
    const mismatched = products.filter((p) => isModeMismatch(p, credentials.activeMode));
    if (mismatched.length === 0) return;

    setBulkResetBusy(true);
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    try {
      for (const product of mismatched) {
        const { cancelled } = await requestWithStepUp(
          `reset-mode-${product.id}`,
          () => fetch(`/api/admin/portal/settings/products/${product.id}/reset-mode`, { method: 'POST' }),
          async (res) => {
            const body = await safeJson(res);
            if (res.ok) {
              setProducts((rows) => rows.map((r) => (r.id === product.id ? { ...r, ...(body.product as object) } : r)));
              succeeded += 1;
            } else if (body.error === 'has_active_subscriptions') {
              blocked += 1;
            } else {
              failed += 1;
            }
          },
        );
        if (cancelled) break;
      }
    } finally {
      setBulkResetBusy(false);
    }

    const parts: string[] = [];
    if (succeeded > 0) parts.push(`${succeeded} recreado${succeeded === 1 ? '' : 's'}`);
    if (blocked > 0) parts.push(`${blocked} con suscriptores activos, sin tocar`);
    if (failed > 0) parts.push(`${failed} con error`);
    if (parts.length > 0) {
      showToast({ kind: blocked > 0 || failed > 0 ? 'error' : 'success', message: parts.join(' · ') + '.' });
    }
  }

  const grouped = new Map<string, ProductRow[]>();
  for (const p of products) {
    grouped.set(p.code, [...(grouped.get(p.code) ?? []), p]);
  }
  const mismatchedCount = products.filter((p) => isModeMismatch(p, credentials.activeMode)).length;

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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Catálogo</h2>
          {mismatchedCount > 0 ? (
            <button
              type="button"
              className="btn-primary"
              disabled={bulkResetBusy}
              onClick={() => resetAllMismatched()}
              data-testid="stripe-reset-all-mismatched"
              title="Reinicia, uno por uno, todos los tramos creados bajo el otro modo — cada uno sigue comprobando por su cuenta que no tenga suscriptores activos."
            >
              {bulkResetBusy
                ? 'Reiniciando…'
                : `Recrear todos en ${credentials.activeMode} (${mismatchedCount})`}
            </button>
          ) : null}
        </div>
        {[...grouped.entries()].map(([code, rows]) => (
          <div key={code} className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{code}</p>
            {rows.map((product) => {
              const bootstrapped = Boolean(product.stripeProductId);
              const modeMismatch = isModeMismatch(product, credentials.activeMode);
              const pf = partialFailures[product.id];
              const draft = repriceDrafts[product.id];
              return (
                <div
                  key={product.id}
                  className={`rounded-xl border p-4 ${
                    product.isActive ? 'border-kairikos-border/60' : 'border-dashed border-kairikos-border'
                  }`}
                  data-testid="stripe-catalog-row"
                  data-active={product.isActive ? 'true' : 'false'}
                >
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
                      {!product.isActive ? (
                        <span
                          className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1 text-xs text-kairikos-muted"
                          data-testid="stripe-catalog-inactive"
                          title="Existe en el catálogo pero no se le ofrece a ningún cliente todavía."
                        >
                          No a la venta
                        </span>
                      ) : null}
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
                        <>
                          {/* Pre-bootstrap: price is still just a number on
                             this row, so it can be edited without ever
                             touching Stripe — see updateDraftPricing. */}
                          <button type="button" className="btn-ghost" onClick={() => toggleReprice(product)}>
                            {repriceOpenFor === product.id ? 'Cancelar' : 'Editar precio'}
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busyKey === `bootstrap-${product.id}`}
                            onClick={() => bootstrapTier(product)}
                            data-testid={`stripe-bootstrap-${product.id}`}
                          >
                            {busyKey === `bootstrap-${product.id}` ? 'Creando…' : 'Crear en Stripe'}
                          </button>
                        </>
                      ) : modeMismatch ? (
                        // Deliberately NOT "Cambiar precio" here: that
                        // action would call Stripe with the ACTIVE key
                        // against an id that only exists under the OTHER
                        // mode's key, and fail. This is the only path
                        // forward.
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busyKey === `reset-mode-${product.id}`}
                          onClick={() => resetModeMismatch(product)}
                          data-testid={`stripe-reset-mode-${product.id}`}
                        >
                          {busyKey === `reset-mode-${product.id}`
                            ? 'Reiniciando…'
                            : `Recrear en ${credentials.activeMode}`}
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
                      {!bootstrapped ? (
                        <p className="text-xs text-kairikos-muted" data-testid={`stripe-draft-price-note-${product.id}`}>
                          Todavía no está creado en Stripe: esto es el precio con el que se creará.
                        </p>
                      ) : impact[product.id] !== undefined ? (
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
                          disabled={busyKey === `${bootstrapped ? 'reprice' : 'draft-price'}-${product.id}`}
                          onClick={() => (bootstrapped ? confirmReprice(product) : confirmDraftPrice(product))}
                          data-testid={`stripe-reprice-confirm-${product.id}`}
                        >
                          {busyKey === `${bootstrapped ? 'reprice' : 'draft-price'}-${product.id}`
                            ? 'Guardando…'
                            : bootstrapped
                              ? 'Confirmar cambio de precio'
                              : 'Guardar precio'}
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
