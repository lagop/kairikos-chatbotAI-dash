'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// SEO con IA, Fase 6 — la revisión del cliente. El operador ya lo
// aprobó internamente (caza alucinaciones/desalineación); esto es la
// ÚLTIMA parada antes de que el artículo salga en vivo en el WordPress
// real del cliente. Mismo esqueleto que SeoContentDraftsPanel.tsx
// (admin) — aprobar/pedir cambios, contenido como texto plano — pero en
// lenguaje de cliente, sin jerga interna ("revisado por", "reintentar
// publicación").
// =============================================================================

export interface SeoDraftReviewData {
  id: string;
  title: string | null;
  bodyHtml: string | null;
  targetKeyword: string | null;
  metaDescription: string | null;
  /** Calculado en el servidor (seo-draft-auto-publish.ts's
   *  computeAutoPublishDeadline) — misma fuente que usa el barrido, para
   *  que esta cuenta atrás nunca pueda desincronizarse. */
  autoPublishDeadline: string | null;
}

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

function DraftReviewItem({ draft }: { draft: SeoDraftReviewData }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  async function review(body: { action: 'approve' } | { action: 'reject'; rejectionReason: string }) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/seo/content-drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError('No se pudo guardar tu decisión. Inténtalo de nuevo.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-kairikos-border p-4" data-testid="seo-draft-review-item">
      <div className="mb-2">
        <p className="text-sm font-semibold">{draft.title ?? 'Artículo listo para tu revisión'}</p>
        {draft.targetKeyword ? <p className="text-xs text-kairikos-muted">Sobre: {draft.targetKeyword}</p> : null}
      </div>

      {draft.bodyHtml ? (
        <div className="mb-3">
          <button type="button" className="text-xs font-medium text-kairikos-accent" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Ocultar contenido' : 'Leer el artículo'}
          </button>
          {expanded ? (
            // Como texto, no renderizado — mismo motivo que en el panel
            // del operador: el contenido viene de un LLM cuyo prompt
            // incluye texto rastreado de la propia web del cliente, y
            // renderizarlo como HTML en una sesión autenticada
            // ejecutaría cualquier <script> que una página comprometida
            // hubiera colado ahí.
            <pre
              className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 text-sm"
              data-testid="seo-draft-review-body"
            >
              {draft.bodyHtml}
            </pre>
          ) : null}
        </div>
      ) : null}

      {draft.autoPublishDeadline ? (
        <div
          className="mb-3 rounded-lg border border-kairikos-border bg-kairikos-surface2/40 p-3 text-sm"
          data-testid="seo-draft-review-auto-publish"
        >
          <p>
            Si no dices nada, se publicará el <strong>{DATE_FORMAT.format(new Date(draft.autoPublishDeadline))}</strong>.
          </p>
        </div>
      ) : null}

      {error ? <p className="mb-2 text-xs text-kairikos-danger">{error}</p> : null}

      <div className="space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => review({ action: 'approve' })}
            data-testid="seo-draft-review-approve"
          >
            Aprobar y publicar
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => setShowRejectForm((v) => !v)}
            data-testid="seo-draft-review-reject-toggle"
          >
            Pedir cambios
          </button>
        </div>
        {showRejectForm ? (
          <div className="space-y-2">
            <textarea
              className="input"
              placeholder="¿Qué cambiarías de este artículo?"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              data-testid="seo-draft-review-reject-input"
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || rejectionReason.trim().length === 0}
              onClick={() => review({ action: 'reject', rejectionReason: rejectionReason.trim() })}
              data-testid="seo-draft-review-reject-confirm"
            >
              Enviar
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function SeoDraftReviewCard({ drafts }: { drafts: SeoDraftReviewData[] }) {
  if (drafts.length === 0) return null;

  return (
    <section className="card space-y-3" aria-label="Artículos para tu revisión" data-testid="seo-draft-review-card">
      <div>
        <p className="text-sm font-semibold">Tienes {drafts.length} artículo{drafts.length === 1 ? '' : 's'} para revisar</p>
        <p className="text-xs text-kairikos-muted">Antes de publicarlo en tu web, échale un vistazo.</p>
      </div>
      <ul className="space-y-3" data-testid="seo-draft-review-list">
        {drafts.map((draft) => (
          <DraftReviewItem key={draft.id} draft={draft} />
        ))}
      </ul>
    </section>
  );
}
