'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 25/10/2026 — marcar un contacto entrante como contactado desde
// /admin/portal/borradores. Corta su seguimiento por correo; por eso pide
// confirmación y no tiene vuelta atrás aquí (ver la ruta).
export function MarkContactedButton({ source, id }: { source: 'web_draft' | 'calculator'; id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark() {
    if (!window.confirm('¿Marcar como contactado? Deja de recibir los correos de seguimiento.')) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/portal/borradores/contactado', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, id }),
      });
      if (!res.ok) {
        setError('No se pudo guardar.');
        return;
      }
      router.refresh();
    } catch {
      setError('Error de red.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={mark} data-testid="mark-contacted">
        {busy ? 'Guardando…' : 'Marcar contactado'}
      </button>
      {error ? <span className="text-xs text-kairikos-danger">{error}</span> : null}
    </span>
  );
}
