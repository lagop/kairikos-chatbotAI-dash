'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Leads Fase 4 — per-lead status transition buttons (nuevo -> contactado
// -> convertido, con descartado como salida lateral). Same busy/message
// shape as ReviewReplyControls.tsx.
//
// This is a client component, so it CANNOT import src/lib/leads.ts
// (server-only) — the same string comparisons are replicated inline
// here, same split WebQuoteEditor.tsx already uses for web-quotes.ts's
// predicates.
// =============================================================================

type LeadStatus = 'nuevo' | 'contactado' | 'convertido' | 'descartado';

export interface LeadStatusControlsProps {
  leadId: string;
  status: LeadStatus;
}

export function LeadStatusControls({ leadId, status }: LeadStatusControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<'contactado' | 'convertido' | 'descartado' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function transition(target: 'contactado' | 'convertido' | 'descartado') {
    setBusy(target);
    setError(null);
    try {
      const res = await fetch(`/api/portal/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(`No se pudo actualizar el lead. ${data?.detail ?? data?.error ?? res.statusText}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(null);
    }
  }

  const canMarkContacted = status === 'nuevo';
  const canMarkConverted = status === 'contactado';
  const canDiscard = status === 'nuevo' || status === 'contactado';

  if (!canMarkContacted && !canMarkConverted && !canDiscard) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2 border-t border-kairikos-border pt-3" data-testid="lead-status-controls">
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="lead-status-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canMarkContacted ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => transition('contactado')}
            disabled={busy !== null}
            data-testid="lead-mark-contacted"
          >
            {busy === 'contactado' ? 'Guardando…' : 'Marcar contactado'}
          </button>
        ) : null}
        {canMarkConverted ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => transition('convertido')}
            disabled={busy !== null}
            data-testid="lead-mark-converted"
          >
            {busy === 'convertido' ? 'Guardando…' : 'Marcar convertido'}
          </button>
        ) : null}
        {canDiscard ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => transition('descartado')}
            disabled={busy !== null}
            data-testid="lead-discard"
          >
            {busy === 'descartado' ? 'Guardando…' : 'Descartar'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
