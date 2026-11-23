'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WebFeedState } from '@/lib/review-feed-rules';

// =============================================================================
// 23/11/2026 — Reseñas en la web Premium: el operador emite el enlace del feed
// de cada ficha para el secreto REVIEWS_FEED_URL del repositorio de la web del
// cliente, y ve si la publicación nocturna lo está leyendo.
// Ver lib/review-feed.ts y la ruta /api/admin/portal/google-business/[id]/web-feed.
// =============================================================================

export interface ReviewWebFeedRow {
  connectionId: string;
  locationName: string;
  status: string;
  state: WebFeedState;
  readAt: string | null;
}

const STATE_LABEL: Record<WebFeedState, string> = {
  sin_enlace: 'Sin enlace: ninguna web lee estas reseñas.',
  sin_leer: 'Enlace emitido. La web aún no lo ha leído: falta el secreto en GitHub o la primera publicación nocturna.',
  al_dia: 'Al día: la web lo lee cada noche.',
  atrasada: 'Atrasada: la web lleva más de 36 horas sin leerlo. Revisa la pestaña Actions de su repositorio.',
};

const ERROR_LABEL: Record<string, string> = {
  not_found: 'No se encontró la ficha.',
  unauthorized: 'Tu sesión expiró: vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor.',
};

const DATE = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Atlantic/Canary' });

export function ReviewWebFeedPanel({ rows }: { rows: ReviewWebFeedRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ connectionId: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(connectionId: string, action: 'issue' | 'revoke') {
    if (action === 'issue' && rows.find((r) => r.connectionId === connectionId)?.state !== 'sin_enlace') {
      if (!window.confirm('El enlace actual dejará de valer y la web no se publicará hasta que cambies el secreto REVIEWS_FEED_URL. ¿Seguir?')) return;
    }
    if (action === 'revoke' && !window.confirm('Ninguna web podrá leer ya estas reseñas. ¿Retirar el enlace?')) return;
    setBusy(connectionId);
    setError(null);
    setIssued(null);
    try {
      const res = await fetch(`/api/admin/portal/google-business/${connectionId}/web-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; feedUrl?: string };
      if (!res.ok) {
        setError(ERROR_LABEL[body.error ?? ''] ?? 'No se pudo hacer.');
        return;
      }
      if (body.feedUrl) setIssued({ connectionId, url: body.feedUrl });
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-kairikos-border p-4" data-testid="review-web-feed">
      <h3 className="text-sm font-semibold">Reseñas en la web Premium</h3>
      <p className="mt-1 text-sm text-kairikos-muted">
        La web del cliente se reconstruye cada noche y lee aquí sus reseñas de Google. El enlace va en el secreto
        <code className="mx-1">REVIEWS_FEED_URL</code>
        de su repositorio (docs/publicacion.md de la plantilla), nunca en el HTML.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-kairikos-muted">El cliente aún no ha conectado ninguna ficha de Google.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((r) => (
            <li key={r.connectionId} className="rounded-lg border border-kairikos-border p-3" data-testid="review-web-feed-row">
              <p className="text-sm font-semibold">{r.locationName}</p>
              <p className={`mt-1 text-sm ${r.state === 'atrasada' ? 'text-kairikos-danger' : 'text-kairikos-muted'}`}>
                {STATE_LABEL[r.state]}
                {r.readAt ? ` Última lectura: ${DATE.format(new Date(r.readAt))}.` : ''}
                {r.status !== 'active' ? ` La ficha está «${r.status}»: la web publica lo último sincronizado.` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void act(r.connectionId, 'issue')}>
                  {r.state === 'sin_enlace' ? 'Emitir enlace' : 'Emitir otro enlace'}
                </button>
                {r.state !== 'sin_enlace' ? (
                  <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void act(r.connectionId, 'revoke')}>
                    Retirar enlace
                  </button>
                ) : null}
              </div>
              {issued?.connectionId === r.connectionId ? (
                <div role="status" className="mt-3 rounded-lg border border-kairikos-success/40 bg-kairikos-success/10 p-3 text-sm">
                  <p>Cópialo ahora: no se vuelve a enseñar.</p>
                  <code className="mt-1 block break-all" data-testid="review-web-feed-url">{issued.url}</code>
                  <p className="mt-1 text-kairikos-muted">En el repositorio de la web: gh secret set REVIEWS_FEED_URL</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
