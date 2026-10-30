'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 30/10/2026 — «Enviar ahora» en /admin/portal/borradores: abre su enlace y le
// manda el correo sin esperar al plazo (lib/public-draft-delivery.ts).
const RESULT: Record<string, string> = {
  not_ready: 'Todavía no está escrito.',
  already: 'Ya estaba enviado.',
  email_failed: 'Enlace abierto, pero el correo falló.',
};

export function SendPublicDraftButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!window.confirm('¿Enviárselo ya? Le llega el correo con su enlace.')) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/portal/borradores/${id}/enviar`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: string } | null;
      if (!res.ok || !body) {
        setError('No se pudo enviar.');
        return;
      }
      if (!body.ok) setError(RESULT[body.result ?? ''] ?? 'No se pudo enviar.');
      router.refresh();
    } catch {
      setError('Error de red.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn-primary text-sm" disabled={busy} onClick={send} data-testid="send-public-draft">
        {busy ? 'Enviando…' : label}
      </button>
      {error ? <span className="text-xs text-kairikos-danger">{error}</span> : null}
    </span>
  );
}
