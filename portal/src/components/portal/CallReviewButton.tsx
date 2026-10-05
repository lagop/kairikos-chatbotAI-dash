'use client';

import { useState } from 'react';

// =============================================================================
// 05/10/2026 — «Pedir reseña» en una llamada de /portal/llamadas. El dueño lo
// pulsa en las que acabaron en trabajo; sale la misma invitación por WhatsApp
// que desde el resumen del día, con su recordatorio a los 4 días.
// =============================================================================

const DATE = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });

const ERROR_LABEL: Record<string, string> = {
  already_requested: 'Ya se le pidió reseña hace poco.',
  blocked: 'Este número pidió no recibir mensajes.',
  no_google: 'Conecta tu ficha de Google para pedir reseñas.',
  no_number: 'Llamó con número oculto: no hay a quién escribir.',
  failed: 'No se pudo enviar. Inténtalo en un rato.',
};

export function CallReviewButton({ callId, requestedAt }: { callId: string; requestedAt: string | null }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>(requestedAt ? 'sent' : 'idle');
  const [when, setWhen] = useState<string | null>(requestedAt);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setState('busy');
    setError(null);
    try {
      const res = await fetch(`/api/portal/recall/calls/${callId}/review-request`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? 'No se pudo enviar. Inténtalo en un rato.');
        setState('idle');
        return;
      }
      setWhen(new Date().toISOString());
      setState('sent');
    } catch {
      setError('Error de red. Inténtalo de nuevo.');
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <span className="text-xs text-kairikos-accent2" data-testid="call-review-requested">
        Reseña pedida{when ? ` el ${DATE.format(new Date(when))}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="text-xs font-medium text-kairikos-accent2 hover:underline disabled:opacity-60"
        onClick={request}
        disabled={state === 'busy'}
        data-testid="call-review-request"
        title="Le mandamos por WhatsApp la invitación a dejarte una reseña en Google."
      >
        {state === 'busy' ? 'Enviando…' : 'Pedir reseña'}
      </button>
      {error ? (
        <span className="text-xs text-kairikos-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
