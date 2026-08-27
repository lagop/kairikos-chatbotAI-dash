'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// SEO con IA, Fase C — the operator's approve/reject queue for
// AI-drafted articles. The client never sees this — same pattern as
// SeoAuditPanel/SeoTechnicalSetupPanel, operator-only tooling on the
// admin client page.
// =============================================================================

export interface SeoContentDraftData {
  id: string;
  title: string | null;
  bodyHtml: string | null;
  targetKeyword: string | null;
  status: string;
  requestedAt: string;
  generatedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending_generation: 'Generando…',
  drafted: 'Pendiente de revisión',
  rejected: 'Rechazado',
  approved: 'Aprobado — pendiente de publicar',
  published: 'Publicado',
  publish_failed: 'Fallo al publicar',
};

function DraftCard({ draft, clientId }: { draft: SeoContentDraftData; clientId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [expanded, setExpanded] = useState(false);

  async function review(body: { action: 'approve' } | { action: 'reject'; rejectionReason: string }) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/portal/seo/${clientId}/content-drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError('No se pudo guardar la decisión. Inténtalo de nuevo.');
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
    <li className="rounded-xl border border-kairikos-border p-4" data-testid="seo-content-draft" data-draft-id={draft.id}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{draft.title ?? 'Sin título todavía'}</p>
          {draft.targetKeyword ? <p className="text-xs text-kairikos-muted">Palabra clave: {draft.targetKeyword}</p> : null}
        </div>
        <span className="whitespace-nowrap rounded-full bg-kairikos-surface2 px-2.5 py-1 text-xs font-medium" data-testid="seo-content-draft-status">
          {STATUS_LABEL[draft.status] ?? draft.status}
        </span>
      </div>

      {draft.status === 'drafted' && draft.bodyHtml ? (
        <div className="mb-3">
          <button type="button" className="text-xs font-medium text-kairikos-accent" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Ocultar contenido' : 'Ver contenido'}
          </button>
          {expanded ? (
            // Shown as raw HTML source, not rendered — this content comes
            // from an LLM whose prompt includes crawled text from the
            // client's OWN website (site audit signals). A compromised or
            // adversarial page could smuggle a <script> into that crawl
            // and have it echoed back into bodyHtml; rendering it live in
            // an authenticated operator session would execute it. The
            // operator can review the markup as text just as well.
            <pre
              className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 text-sm"
              data-testid="seo-content-draft-body"
            >
              {draft.bodyHtml}
            </pre>
          ) : null}
        </div>
      ) : null}

      {draft.status === 'rejected' && draft.rejectionReason ? (
        <p className="mb-3 text-xs text-kairikos-danger" data-testid="seo-content-draft-rejection-reason">
          Motivo: {draft.rejectionReason}
        </p>
      ) : null}

      {error ? <p className="mb-2 text-xs text-kairikos-danger">{error}</p> : null}

      {draft.status === 'drafted' ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => review({ action: 'approve' })}
              data-testid="seo-content-draft-approve"
            >
              Aprobar
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setShowRejectForm((v) => !v)}
              data-testid="seo-content-draft-reject-toggle"
            >
              Rechazar
            </button>
          </div>
          {showRejectForm ? (
            <div className="space-y-2">
              <textarea
                className="input"
                placeholder="¿Por qué se rechaza este borrador?"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                data-testid="seo-content-draft-rejection-input"
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || rejectionReason.trim().length === 0}
                onClick={() => review({ action: 'reject', rejectionReason: rejectionReason.trim() })}
                data-testid="seo-content-draft-reject-confirm"
              >
                Confirmar rechazo
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function SeoContentDraftsPanel({ clientId, drafts }: { clientId: string; drafts: SeoContentDraftData[] }) {
  if (drafts.length === 0) {
    return (
      <div className="border-t border-kairikos-border pt-4" data-testid="seo-content-drafts-panel">
        <p className="text-sm font-semibold">Artículos generados</p>
        <p className="mt-1 text-sm text-kairikos-muted">Todavía no se ha generado ningún borrador para este cliente.</p>
      </div>
    );
  }

  return (
    <div className="border-t border-kairikos-border pt-4" data-testid="seo-content-drafts-panel">
      <p className="mb-3 text-sm font-semibold">Artículos generados</p>
      <ul className="space-y-3">
        {drafts.map((draft) => (
          <DraftCard key={draft.id} draft={draft} clientId={clientId} />
        ))}
      </ul>
    </div>
  );
}
