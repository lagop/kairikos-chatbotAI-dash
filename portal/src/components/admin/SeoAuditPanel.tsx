'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// SEO con IA, Fase A — the operator's diagnostic tool: runs
// seo-audit.ts's auditWebsite() on demand and shows the last result.
// Separate from SeoTechnicalSetupPanel.tsx on purpose — this is a
// read/diagnose action, not part of the client/operator column-segmented
// onboarding fields.
// =============================================================================

export interface SeoAuditResultData {
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  h1Texts: string[];
  imagesTotal: number;
  imagesMissingAlt: number;
  linksInternal: number;
  linksExternal: number;
  brokenLinksChecked: number;
  brokenLinks: { url: string; status: number | null }[];
  checkedAt: string;
}

const ERROR_LABEL: Record<string, string> = {
  not_found: 'El cliente aún no ha empezado el onboarding.',
  no_site_url: 'El cliente aún no indicó la URL de su sitio.',
  audit_failed: 'No se pudo acceder al sitio. Revisa la URL o inténtalo de nuevo más tarde.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

export function SeoAuditPanel({
  clientId,
  hasSiteUrl,
  lastAuditAt,
  lastAuditResult,
  lastAuditError,
}: {
  clientId: string;
  hasSiteUrl: boolean;
  lastAuditAt: string | null;
  lastAuditResult: SeoAuditResultData | null;
  lastAuditError: string | null;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAudit() {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/admin/portal/seo/${clientId}/audit`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo ejecutar la auditoría.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-t border-kairikos-border pt-4" data-testid="seo-audit-panel">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Auditoría técnica</p>
          <p className="text-xs text-kairikos-muted" data-testid="seo-audit-status">
            {lastAuditAt
              ? `Última auditoría: ${new Date(lastAuditAt).toLocaleString('es-ES')}.`
              : 'Todavía no se ha ejecutado ninguna auditoría.'}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={runAudit}
          disabled={running || !hasSiteUrl}
          data-testid="seo-audit-run"
        >
          {running ? 'Auditando…' : 'Ejecutar auditoría'}
        </button>
      </div>

      {!hasSiteUrl ? (
        <p className="text-sm text-kairikos-muted">El cliente todavía no indicó la URL de su sitio.</p>
      ) : null}

      {error ? (
        <p className="mb-3 text-sm text-kairikos-danger" data-testid="seo-audit-error">
          {error}
        </p>
      ) : null}

      {!error && lastAuditError ? (
        <p className="mb-3 text-sm text-kairikos-danger" data-testid="seo-audit-last-error">
          El último intento falló: {lastAuditError}. Se muestra el resultado de la auditoría anterior.
        </p>
      ) : null}

      {lastAuditResult ? (
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2" data-testid="seo-audit-result">
          <div>
            <dt className="text-xs text-kairikos-muted">Título de la página</dt>
            <dd>{lastAuditResult.title ?? <span className="text-kairikos-danger">Sin título</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-kairikos-muted">Meta descripción</dt>
            <dd>{lastAuditResult.metaDescription ?? <span className="text-kairikos-danger">Sin meta descripción</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-kairikos-muted">Encabezados H1</dt>
            <dd className={lastAuditResult.h1Count === 1 ? '' : 'text-kairikos-danger'}>
              {lastAuditResult.h1Count} {lastAuditResult.h1Count === 1 ? '(correcto)' : '(debería ser 1)'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-kairikos-muted">Imágenes sin texto alternativo</dt>
            <dd className={lastAuditResult.imagesMissingAlt === 0 ? '' : 'text-kairikos-danger'}>
              {lastAuditResult.imagesMissingAlt} de {lastAuditResult.imagesTotal}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-kairikos-muted">Enlaces</dt>
            <dd>
              {lastAuditResult.linksInternal} internos, {lastAuditResult.linksExternal} externos
            </dd>
          </div>
          <div>
            <dt className="text-xs text-kairikos-muted">
              Enlaces rotos ({lastAuditResult.brokenLinksChecked} internos revisados)
            </dt>
            <dd className={lastAuditResult.brokenLinks.length === 0 ? '' : 'text-kairikos-danger'}>
              {lastAuditResult.brokenLinks.length === 0 ? 'Ninguno' : `${lastAuditResult.brokenLinks.length} roto(s)`}
            </dd>
          </div>
          {lastAuditResult.brokenLinks.length > 0 ? (
            <ul className="sm:col-span-2 list-inside list-disc text-xs text-kairikos-muted" data-testid="seo-audit-broken-links">
              {lastAuditResult.brokenLinks.map((link) => (
                <li key={link.url}>
                  {link.url} — {link.status ?? 'sin respuesta'}
                </li>
              ))}
            </ul>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
