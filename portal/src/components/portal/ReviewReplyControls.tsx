'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP-22c — per-review "generar borrador con IA → editar → aprobar y
// publicar" flow. Publishing always sends whatever is currently in the
// textarea (state `text`), never the original AI draft straight from
// the API response — that's what makes an edited draft publish as
// edited (the AC).
// =============================================================================

export interface ReviewReplyControlsProps {
  reviewId: string;
  initialDraft: string | null;
}

export function ReviewReplyControls({ reviewId, initialDraft }: ReviewReplyControlsProps) {
  const router = useRouter();
  const [text, setText] = useState(initialDraft ?? '');
  const [busy, setBusy] = useState<'draft' | 'publish' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  async function generateDraft() {
    setBusy('draft');
    setMessage(null);
    try {
      const res = await fetch(`/api/portal/google-business/reviews/${reviewId}/draft`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage({ kind: 'error', text: `No se pudo generar el borrador. ${data?.detail ?? data?.error ?? res.statusText}` });
        return;
      }
      setText(data.draft as string);
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!text.trim()) return;
    setBusy('publish');
    setMessage(null);
    try {
      const res = await fetch(`/api/portal/google-business/reviews/${reviewId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: text.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.error === 'needs_reconnect') {
          setMessage({ kind: 'error', text: 'Tu conexión con Google necesita reconectarse antes de poder publicar. Ve arriba y pulsa "Reconectar con Google".' });
        } else {
          setMessage({ kind: 'error', text: `No se pudo publicar la respuesta. ${data?.detail ?? data?.error ?? res.statusText}` });
        }
        return;
      }
      setMessage({ kind: 'success', text: 'Respuesta publicada en Google.' });
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-kairikos-border pt-3" data-testid="review-reply-controls">
      {message ? (
        <p
          className={message.kind === 'success' ? 'text-sm text-kairikos-success' : 'text-sm text-kairikos-danger'}
          data-testid="review-reply-message"
        >
          {message.text}
        </p>
      ) : null}

      {!text ? (
        <button
          type="button"
          className="btn-ghost"
          onClick={generateDraft}
          disabled={busy !== null}
          data-testid="review-reply-generate-draft"
        >
          {busy === 'draft' ? 'Generando…' : 'Generar respuesta con IA'}
        </button>
      ) : (
        <>
          <textarea
            className="input min-h-[90px] w-full"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="review-reply-draft-text"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={publish}
              disabled={busy !== null || !text.trim()}
              data-testid="review-reply-publish"
            >
              {busy === 'publish' ? 'Publicando…' : 'Aprobar y publicar'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={generateDraft}
              disabled={busy !== null}
              data-testid="review-reply-regenerate"
            >
              {busy === 'draft' ? 'Generando…' : 'Regenerar borrador'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
