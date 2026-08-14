'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP-18 — operator-facing assign/retire UI for ClientProduct rows. Mirrors
// OperatorEditor's per-field fetch + toast pattern. Every mutation hits the
// client-products API routes, which now wrap the ClientProduct write and
// its ClientProductAudit row in a single `$transaction` (see
// api/admin/portal/client-products/route.ts and [id]/route.ts) — this
// component doesn't need to know that, it just reads the resulting rows.
// =============================================================================

export interface AssignableProduct {
  id: string;
  code: string;
  tier: string;
  name: string;
  priceCents: number;
  currency: string;
}

export interface ClientProductRow {
  id: string;
  productId: string;
  code: string;
  tier: string;
  name: string;
  status: string;
  subscribedAt: string;
  cancelledAt: string | null;
}

interface ProductAssignmentProps {
  clientId: string;
  assigned: ClientProductRow[];
  assignable: AssignableProduct[];
}

type ToastState = { kind: 'success' | 'error'; message: string } | null;

const STATUS_LABEL: Record<string, string> = {
  active: 'Activo',
  paused: 'En pausa',
  cancelled: 'Retirado',
  past_due: 'Pago pendiente',
};

const STATUS_PILL: Record<string, string> = {
  active: 'pill-success',
  paused: 'pill-warning',
  cancelled: 'pill-muted',
  past_due: 'pill-danger',
};

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

export function ProductAssignment({ clientId, assigned, assignable }: ProductAssignmentProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>(assignable[0]?.id ?? '');

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 4500);
  };

  const refresh = () => startTransition(() => router.refresh());

  async function retire(row: ClientProductRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/admin/portal/client-products/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      showToast({ kind: 'success', message: `${row.name} retirado del cliente.` });
      refresh();
    } catch (err) {
      showToast({ kind: 'error', message: `No se pudo retirar: ${err instanceof Error ? err.message : 'error desconocido'}` });
    } finally {
      setBusyId(null);
    }
  }

  async function reactivate(row: ClientProductRow) {
    setBusyId(row.id);
    try {
      const res = await fetch('/api/admin/portal/client-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, productId: row.productId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      showToast({ kind: 'success', message: `${row.name} reactivado.` });
      refresh();
    } catch (err) {
      showToast({ kind: 'error', message: `No se pudo reactivar: ${err instanceof Error ? err.message : 'error desconocido'}` });
    } finally {
      setBusyId(null);
    }
  }

  async function assign() {
    if (!selectedProductId) return;
    setBusyId('assign');
    try {
      const res = await fetch('/api/admin/portal/client-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, productId: selectedProductId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      const product = assignable.find((p) => p.id === selectedProductId);
      showToast({ kind: 'success', message: `${product?.name ?? 'Producto'} asignado al cliente.` });
      refresh();
    } catch (err) {
      showToast({ kind: 'error', message: `No se pudo asignar: ${err instanceof Error ? err.message : 'error desconocido'}` });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Productos contratados" data-testid="product-assignment">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Productos contratados</h2>
      </header>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="product-assignment-toast"
          data-toast-kind={toast.kind}
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {assigned.length === 0 ? (
        <p className="text-sm text-kairikos-muted">Este cliente no tiene productos asignados todavía.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {assigned.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
              data-testid="product-assignment-row"
              data-product-code={row.code}
              data-status={row.status}
            >
              <div className="flex flex-col">
                <span className="text-sm font-semibold">{row.name}</span>
                <span className="text-xs text-kairikos-muted">
                  Desde {DATE_FORMAT.format(new Date(row.subscribedAt))}
                  {row.cancelledAt ? ` · Retirado ${DATE_FORMAT.format(new Date(row.cancelledAt))}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={STATUS_PILL[row.status] ?? 'pill-muted'}>{STATUS_LABEL[row.status] ?? row.status}</span>
                {row.status === 'cancelled' ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    data-testid={`product-reactivate-${row.code}`}
                    disabled={busyId === row.id || isPending}
                    onClick={() => reactivate(row)}
                  >
                    {busyId === row.id ? 'Reactivando…' : 'Reactivar'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost"
                    data-testid={`product-retire-${row.code}`}
                    disabled={busyId === row.id || isPending}
                    onClick={() => retire(row)}
                  >
                    {busyId === row.id ? 'Retirando…' : 'Retirar'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {assignable.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-kairikos-border pt-4">
          <div className="flex-1 min-w-[220px] space-y-1">
            <label htmlFor="product-assignment-select" className="label">
              Asignar nuevo producto
            </label>
            <select
              id="product-assignment-select"
              className="input"
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              data-testid="product-assignment-select"
            >
              {assignable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {formatPrice(p.priceCents, p.currency)}/mes
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn-primary"
            data-testid="product-assignment-assign"
            disabled={busyId === 'assign' || isPending || !selectedProductId}
            onClick={assign}
          >
            {busyId === 'assign' ? 'Asignando…' : 'Asignar'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
