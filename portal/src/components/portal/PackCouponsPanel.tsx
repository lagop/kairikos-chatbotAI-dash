'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from './TotpStepUpModal';

// =============================================================================
// Plan de precios del 01/10/2026 — los cupones de los packs de productos
// (Pack Oficio, Pack Presencia). Se crean una vez; a partir de ahí el cron
// sync-pack-discounts los aplica solo a quien tiene la combinación
// (lib/pack-discounts.ts).
// =============================================================================

export interface PackCouponRow {
  packCode: string;
  interval: string;
  stripeCouponId: string;
  amountOffCents: number;
  stripeMode: string | null;
}

const LABEL: Record<string, string> = { oficio: 'Pack Oficio', presencia: 'Pack Presencia' };
const ERROR_LABEL: Record<string, string> = {
  reviews_basic_not_bootstrapped: 'Primero crea Reseñas Basic en Stripe: el descuento va en su suscripción.',
  stripe_error: 'Stripe no aceptó la operación. Revisa la clave activa e inténtalo de nuevo.',
};

function money(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function PackCouponsPanel({ coupons }: { coupons: PackCouponRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const complete = coupons.length >= 4;

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/portal/settings/pack-coupons', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; created?: number };
      if (res.status === 403 && body.error === 'totp_step_up_required') {
        setStepUp(true);
        return;
      }
      if (!res.ok) {
        setMessage(ERROR_LABEL[body.error ?? ''] ?? 'No se pudo completar la operación.');
        return;
      }
      setMessage(`Cupones creados: ${body.created ?? 0}.`);
      router.refresh();
    } catch {
      setMessage('Error de red.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3" aria-label="Packs de productos" data-testid="pack-coupons-panel">
      <div>
        <h2 className="text-lg font-semibold">Packs de productos</h2>
        <p className="text-sm text-kairikos-muted">
          Pack Oficio (Llamadas Autónomo + Reseñas Basic) y Pack Presencia (Web + Cuidado + Reseñas Basic). El descuento
          va en la suscripción de Reseñas Basic y se aplica solo cuando el cliente tiene la combinación; se quita cuando
          deja de tenerla.
        </p>
      </div>
      {coupons.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {coupons.map((c) => (
            <li key={c.stripeCouponId}>
              {LABEL[c.packCode] ?? c.packCode} · {c.interval === 'year' ? 'anual' : 'mensual'} · −{money(c.amountOffCents)}
              <span className="text-kairikos-muted"> · {c.stripeCouponId}{c.stripeMode ? ` (${c.stripeMode})` : ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-kairikos-muted">Todavía no hay cupones: hasta crearlos, nadie recibe el descuento.</p>
      )}
      {!complete ? (
        <button type="button" className="btn-primary" disabled={busy} onClick={create} data-testid="pack-coupons-create">
          {busy ? 'Creando…' : 'Crear los cupones en Stripe'}
        </button>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}
      {stepUp ? (
        <TotpStepUpModal
          onCancel={() => setStepUp(false)}
          onVerified={() => {
            setStepUp(false);
            void create();
          }}
        />
      ) : null}
    </section>
  );
}
