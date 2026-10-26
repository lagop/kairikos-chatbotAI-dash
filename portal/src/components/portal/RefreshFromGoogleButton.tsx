'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 26/10/2026 — «Actualizar desde Google» de un prospecto con los datos
// caducados (lib/places-retention.ts). Lo usan /portal/leads y la ficha del
// cliente en el admin, cada uno con su ruta. El mensaje lo pone el servidor
// —incluido el del tope del día y el de «Google ya no lo encuentra»— y la
// tarjeta se repinta sola con los datos nuevos.
export function RefreshFromGoogleButton({ endpoint }: { endpoint: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function refresh() {
    setMessage(null);
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      const ok = res.ok && body?.ok === true;
      setMessage({ ok, text: body?.message ?? (ok ? 'Datos actualizados.' : 'No se pudo actualizar.') });
      // También tras «ya no lo encuentra»: la ficha pasa a decirlo.
      if (ok || res.status === 409) router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Error de red. Prueba otra vez.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={refresh} data-testid="refresh-from-google">
        {busy ? 'Pidiendo a Google…' : 'Actualizar desde Google'}
      </button>
      {message ? (
        <span role="status" className={`text-xs ${message.ok ? 'text-kairikos-success' : 'text-kairikos-danger'}`}>
          {message.text}
        </span>
      ) : null}
    </span>
  );
}

// El operador: todos los caducados de un cliente de una vez, con confirmación
// porque cada uno es una llamada de pago a Google (hasta el tope del día).
export function RefreshAllExpiredButton({ clientId, count }: { clientId: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function refreshAll() {
    if (!window.confirm(`¿Pedir a Google los datos de ${count} prospectos caducados? Cada uno es una consulta de pago, y se para al llegar al tope del día.`)) return;
    setMessage(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/portal/clients/${encodeURIComponent(clientId)}/leads-caducados`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      const ok = res.ok && body?.ok === true;
      setMessage({ ok, text: body?.message ?? (ok ? 'Hecho.' : 'No se pudo actualizar.') });
      if (ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Error de red. Prueba otra vez.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={refreshAll} data-testid="refresh-all-expired">
        {busy ? 'Pidiendo a Google…' : `Actualizar los ${count} caducados`}
      </button>
      {message ? (
        <span role="status" className={`text-xs ${message.ok ? 'text-kairikos-success' : 'text-kairikos-danger'}`}>
          {message.text}
        </span>
      ) : null}
    </span>
  );
}
