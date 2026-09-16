'use client';

import { useCallback, useEffect, useState } from 'react';
import { TotpStepUpModal } from '@/components/portal/TotpStepUpModal';

// =============================================================================
// /admin/portal/settings/billing — códigos que anulan el alta de un tier.
// Ver lib/stripe-promotions.ts para el porqué y el funcionamiento en Stripe.
//
// La lista se pide al cargar (no en el render del servidor) porque sale de
// la API de Stripe: si Stripe tarda o falla, el resto de la página de
// Facturación no tiene por qué esperar ni romperse.
// =============================================================================

export interface PromotionProductOption {
  id: string;
  name: string;
  setupFeeCents: number;
  currency: string;
}

interface WaiverCode {
  id: string;
  code: string;
  active: boolean;
  productName: string | null;
  amountOffCents: number;
  currentSetupFeeCents: number | null;
  stale: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_code: 'El código solo puede llevar letras, números, guiones y guiones bajos (3 a 40).',
  invalid_expiry: 'La fecha de caducidad tiene que ser futura.',
  code_already_exists: 'Ya existe un código activo con ese texto en Stripe.',
  no_setup_fee: 'Ese producto no tiene alta que anular.',
  not_bootstrapped: 'Ese producto aún no tiene precios creados en Stripe.',
  product_not_found: 'No se encontró el producto.',
  operator_session_required: 'Hace falta iniciar sesión como operador (no vale la clave de API).',
  service_unavailable: 'Stripe no está configurado.',
  stripe_error: 'Stripe rechazó la operación. Inténtalo de nuevo en un momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  invalid_body: 'Revisa los campos.',
  internal_error: 'Algo falló en el servidor.',
};

function money(cents: number, currency = 'EUR') {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

const DATE = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function PromotionCodesPanel({ products }: { products: PromotionProductOption[] }) {
  const [codes, setCodes] = useState<WaiverCode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [stepUp, setStepUp] = useState<null | { onVerified: () => void; onCancel: () => void }>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await fetch('/api/admin/portal/settings/promotions').catch(() => null);
    if (!res) return setLoadError('Error de red al cargar los códigos.');
    const body = await safeJson(res);
    if (!res.ok) return setLoadError(ERROR_LABEL[body.error as string] ?? 'No se pudieron cargar los códigos.');
    setCodes((body.codes as WaiverCode[]) ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setMessage(null);
    const doFetch = () =>
      fetch('/api/admin/portal/settings/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          code,
          expiresOn: expiresOn || null,
          maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
        }),
      });

    const run = async (): Promise<void> => {
      setBusy('create');
      let res: Response;
      try {
        res = await doFetch();
      } catch (err) {
        setBusy(null);
        setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
        return;
      }
      setBusy(null);
      const body = await safeJson(res);
      if (res.status === 403 && body.error === 'totp_step_up_required') {
        setStepUp({
          onVerified: () => {
            setStepUp(null);
            void run();
          },
          onCancel: () => setStepUp(null),
        });
        return;
      }
      if (!res.ok) {
        setMessage({ kind: 'error', text: ERROR_LABEL[body.error as string] ?? 'No se pudo crear el código.' });
        return;
      }
      const created = body.promotionCode as WaiverCode;
      setMessage({ kind: 'ok', text: `Código ${created.code} creado. Ya se puede usar en el pago.` });
      setCode('');
      setExpiresOn('');
      setMaxRedemptions('');
      await load();
    };
    await run();
  }

  async function deactivate(item: WaiverCode) {
    if (!window.confirm(`¿Desactivar ${item.code}? Nadie más podrá usarlo; a quien ya lo usó no le afecta.`)) return;
    setMessage(null);
    setBusy(item.id);
    const res = await fetch(`/api/admin/portal/settings/promotions/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
    }).catch(() => null);
    setBusy(null);
    if (!res) return setMessage({ kind: 'error', text: 'Error de red.' });
    const body = await safeJson(res);
    if (!res.ok) {
      setMessage({ kind: 'error', text: ERROR_LABEL[body.error as string] ?? 'No se pudo desactivar.' });
      return;
    }
    setMessage({ kind: 'ok', text: `Código ${item.code} desactivado.` });
    await load();
  }

  const selected = products.find((p) => p.id === productId);

  return (
    <section className="card space-y-5" aria-label="Códigos sin alta" data-testid="promotion-codes-card">
      <div>
        <h2 className="font-semibold">Códigos sin alta</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Un código que el cliente escribe al pagar y que le descuenta el alta del producto elegido. Paga solo la cuota
          del primer mes. Sirve para ofertas de lanzamiento: se desactiva cuando quieras sin tocar el precio del
          catálogo.
        </p>
      </div>

      {products.length === 0 ? (
        <p className="text-sm text-kairikos-muted">
          Ningún producto tiene alta con precio en Stripe todavía, así que no hay nada que anular.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">Producto</span>
            <select
              className="input w-full"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              data-testid="promotion-product"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — alta {money(p.setupFeeCents, p.currency)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Código</span>
            <input
              className="input w-full font-mono uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="LANZAMIENTO"
              maxLength={40}
              data-testid="promotion-code"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Caduca el (opcional)</span>
            <input
              type="date"
              className="input w-full"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              data-testid="promotion-expires"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Usos máximos (opcional)</span>
            <input
              type="number"
              min={1}
              className="input w-full"
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder="Sin límite"
              data-testid="promotion-max"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-primary w-full"
              disabled={!code.trim() || !productId || busy !== null}
              onClick={create}
              data-testid="promotion-create"
            >
              {busy === 'create'
                ? 'Creando…'
                : selected
                  ? `Crear código (−${money(selected.setupFeeCents, selected.currency)})`
                  : 'Crear código'}
            </button>
          </div>
        </div>
      )}

      {message ? (
        <p
          className={`text-sm ${message.kind === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}
          data-testid="promotion-message"
        >
          {message.text}
        </p>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Códigos creados</h3>
        {loadError ? (
          <p className="text-sm text-kairikos-danger">{loadError}</p>
        ) : codes === null ? (
          <p className="text-sm text-kairikos-muted">Cargando…</p>
        ) : codes.length === 0 ? (
          <p className="text-sm text-kairikos-muted" data-testid="promotion-empty">
            Todavía no hay ninguno.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="promotion-list">
            {codes.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border px-3 py-2"
                data-active={item.active ? 'true' : 'false'}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{item.code}</span>
                    <span className={item.active ? 'pill-success' : 'pill-muted'}>
                      {item.active ? 'Activo' : 'Desactivado'}
                    </span>
                    {item.stale && item.active ? (
                      <span className="pill-warning" title="El alta del producto cambió después de crear el código">
                        Importe desfasado
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-kairikos-muted">
                    {item.productName ?? 'Producto desconocido'} · −{money(item.amountOffCents)}
                    {item.stale && item.currentSetupFeeCents !== null
                      ? ` (el alta ahora es ${money(item.currentSetupFeeCents)})`
                      : ''}{' '}
                    · {item.timesRedeemed}
                    {item.maxRedemptions ? `/${item.maxRedemptions}` : ''} usos
                    {item.expiresAt ? ` · caduca ${DATE.format(new Date(item.expiresAt))}` : ''}
                  </p>
                </div>
                {item.active ? (
                  <button
                    type="button"
                    className="btn-ghost text-sm"
                    disabled={busy !== null}
                    onClick={() => deactivate(item)}
                  >
                    {busy === item.id ? 'Desactivando…' : 'Desactivar'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </section>
  );
}
