'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 09/11/2026 — mover un presupuesto de Web Premium, e imprimirlo: «Guardar como
// PDF» desde el diálogo del navegador es el desglose que la página le promete
// al visitante.

const ACCIONES: Record<string, { to: string; label: string }[]> = {
  nuevo: [
    { to: 'contactado', label: 'Marcar contactado' },
    { to: 'convertido', label: 'Ganado' },
    { to: 'descartado', label: 'Descartar' },
  ],
  contactado: [
    { to: 'convertido', label: 'Ganado' },
    { to: 'descartado', label: 'Descartar' },
  ],
  convertido: [{ to: 'contactado', label: 'Reabrir' }],
  descartado: [{ to: 'contactado', label: 'Reabrir' }],
};

export function PremiumQuoteActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function move(to: string) {
    setBusy(true);
    setError(false);
    const res = await fetch(`/api/admin/portal/presupuestos-premium/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) router.refresh();
    else setError(true);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {(ACCIONES[status] ?? []).map((a) => (
        <button key={a.to} type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => move(a.to)}>
          {a.label}
        </button>
      ))}
      <button type="button" className="btn-ghost text-sm" onClick={() => window.print()}>
        Imprimir o guardar PDF
      </button>
      {error ? <span className="text-sm text-kairikos-danger">No se ha podido cambiar.</span> : null}
    </div>
  );
}
