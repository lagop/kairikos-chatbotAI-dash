'use client';

import { useState, useEffect, useCallback } from 'react';

type WizardBlock = 'identidad' | 'comportamiento' | 'activacion';
type WizardStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

interface StepListEntry {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: WizardBlock;
  requiredForReady: boolean;
  visible: boolean;
  autoConfigured: boolean;
  v11Deferred: boolean;
}

interface StepListResponse {
  clientId: string;
  clientTier: string | null;
  steps: StepListEntry[];
}

interface StepVersion {
  id: string;
  version: number;
  status: string;
  payload: unknown;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByOperatorId: string | null;
  activeForBot: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AuditEntry {
  id: string;
  stepId: string;
  version: number;
  actor: string;
  actorId: string | null;
  action: string;
  comment: string | null;
  createdAt: string;
}

interface StepDetailResponse {
  client: {
    id: string;
    name: string;
    companyName: string;
    email: string;
    tier: string;
    state: string;
    goLiveAt: string | null;
  };
  versions: StepVersion[];
  auditLogs: AuditEntry[];
  tierView?: Record<string, unknown>;
}

interface AdminConfigReviewProps {
  clientId: string;
  productCode?: string;
}

const BLOCK_LABEL: Record<WizardBlock, string> = {
  identidad: 'Identidad',
  comportamiento: 'Comportamiento',
  activacion: 'Activación',
};

const BLOCK_ORDER: Record<WizardBlock, number> = {
  identidad: 1,
  comportamiento: 2,
  activacion: 3,
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  submitted: 'En revisión',
  approved: 'Aprobado',
  needs_revision: 'Requiere cambios',
};

const STATUS_PILL: Record<string, string> = {
  draft: 'pill-muted',
  submitted: 'pill-warning',
  approved: 'pill-success',
  needs_revision: 'pill-danger',
};

const AUDIT_ACTION_LABEL: Record<string, string> = {
  edit: 'Edición',
  submit: 'Envío',
  approve: 'Aprobación',
  request_revision: 'Solicitud de cambios',
  activate: 'Activación',
  deactivate: 'Desactivación',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatPayload(payload: unknown): string {
  if (!payload) return '—';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function StepSkeleton() {
  return (
    <div className="card animate-pulse p-4">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-kairikos-border" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-48 rounded bg-kairikos-border" />
          <div className="h-3 w-24 rounded bg-kairikos-border" />
        </div>
        <div className="h-6 w-24 rounded bg-kairikos-border" />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status || !STATUS_LABEL[status]) {
    return <span className="pill-muted">Sin datos</span>;
  }
  return <span className={STATUS_PILL[status] ?? 'pill-muted'}>{STATUS_LABEL[status]}</span>;
}

function AuditTrail({ logs, versions }: { logs: AuditEntry[]; versions: StepVersion[] }) {
  if (!logs.length) {
    return <p className="text-sm text-kairikos-muted">Sin actividad registrada.</p>;
  }

  const versionMap = new Map(versions.map((v) => [v.version, v]));

  return (
    <ol className="relative space-y-3 border-l border-kairikos-border pl-4">
      {logs.map((entry) => {
        const dotClass =
          entry.action === 'approve' || entry.action === 'activate'
            ? 'bg-kairikos-success'
            : entry.action === 'request_revision'
              ? 'bg-kairikos-danger'
              : entry.action === 'submit'
                ? 'bg-kairikos-accent2'
                : 'bg-kairikos-muted';
        return (
          <li key={entry.id} className="relative" data-testid={`audit-entry-${entry.id}`}>
            <span aria-hidden className={`absolute -left-[18px] top-1.5 h-2.5 w-2.5 rounded-full ${dotClass}`} />
            <div className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{AUDIT_ACTION_LABEL[entry.action] ?? entry.action}</span>
                <span className="text-xs text-kairikos-muted">
                  v{entry.version} · {entry.actor === 'operator' ? 'Operador' : entry.actor === 'client' ? 'Cliente' : 'Sistema'}
                </span>
              </div>
              {entry.comment ? (
                <p className="text-sm text-kairikos-muted">{entry.comment}</p>
              ) : null}
              <p className="text-xs text-kairikos-muted">{DATE_FORMAT.format(new Date(entry.createdAt))}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PayloadViewer({ payload, label }: { payload: unknown; label: string }) {
  if (!payload) return null;
  const formatted = formatPayload(payload);
  if (formatted === '—') return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">{label}</p>
      <pre className="overflow-x-auto rounded bg-kairikos-surface2 p-3 text-xs leading-relaxed text-kairikos-text">
        {formatted}
      </pre>
    </div>
  );
}

export default function AdminConfigReview({ clientId, productCode = 'chatbot' }: AdminConfigReviewProps) {
  const [steps, setSteps] = useState<StepListEntry[] | null>(null);
  const [stepDetails, setStepDetails] = useState<Map<string, StepDetailResponse>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revisionComment, setRevisionComment] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/admin/portal/wizard/${encodeURIComponent(clientId)}/steps?productCode=${encodeURIComponent(productCode)}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 503) throw new Error('database_not_configured');
          if (res.status === 401) throw new Error('unauthorized');
          throw new Error(`HTTP ${res.status}`);
        }
        const data: StepListResponse = await res.json();
        if (cancelled) return;
        setSteps(data.steps);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [clientId, productCode]);

  useEffect(() => {
    if (!steps || steps.length === 0) return;

    const activeSteps = steps.filter((s) => !s.v11Deferred);
    if (activeSteps.length === 0) return;

    let cancelled = false;

    Promise.all(
      activeSteps.map((s) =>
        fetch(`/api/admin/portal/wizard/${encodeURIComponent(clientId)}/${s.key}?productCode=${encodeURIComponent(productCode)}`)
          .then(async (res) => {
            if (!res.ok) return null;
            const detail: StepDetailResponse = await res.json();
            return { key: s.key, detail };
          })
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<string, StepDetailResponse>();
      for (const r of results) {
        if (r) map.set(r.key, r.detail);
      }
      setStepDetails(map);
    });

    return () => { cancelled = true; };
  }, [clientId, productCode, steps]);

  const handleApprove = useCallback(async (stepKey: string) => {
    setActionLoading(stepKey);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/portal/wizard/${encodeURIComponent(clientId)}/${stepKey}?productCode=${encodeURIComponent(productCode)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json();

      setStepDetails((prev) => {
        const next = new Map(prev);
        const existing = next.get(stepKey);
        if (existing) {
          next.set(stepKey, {
            ...existing,
            versions: existing.versions.map((v) =>
              v.version === result.version
                ? { ...v, status: 'approved', activeForBot: true, approvedAt: result.approvedAt }
                : v.activeForBot
                  ? { ...v, activeForBot: false }
                  : v,
            ),
            auditLogs: [
              {
                id: `approve-${Date.now()}`,
                stepId: result.stepId,
                version: result.version,
                actor: 'operator',
                actorId: null,
                action: 'approve',
                comment: null,
                createdAt: new Date().toISOString(),
              },
              {
                id: `activate-${Date.now()}`,
                stepId: result.stepId,
                version: result.version,
                actor: 'system',
                actorId: null,
                action: 'activate',
                comment: null,
                createdAt: new Date().toISOString(),
              },
              ...(existing.auditLogs ?? []),
            ],
          });
        }
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Error al aprobar');
    } finally {
      setActionLoading(null);
    }
  }, [clientId, productCode]);

  const handleRequestRevision = useCallback(async (stepKey: string) => {
    if (!revisionComment.trim()) {
      setActionError('El comentario es obligatorio para solicitar cambios.');
      return;
    }
    setActionLoading(stepKey);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/portal/wizard/${encodeURIComponent(clientId)}/${stepKey}?productCode=${encodeURIComponent(productCode)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_revision', comment: revisionComment.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json();

      setStepDetails((prev) => {
        const next = new Map(prev);
        const existing = next.get(stepKey);
        if (existing) {
          next.set(stepKey, {
            ...existing,
            versions: existing.versions.map((v) =>
              v.version === result.version
                ? { ...v, status: 'needs_revision' }
                : v,
            ),
            auditLogs: [
              {
                id: `revision-${Date.now()}`,
                stepId: result.stepId,
                version: result.version,
                actor: 'operator',
                actorId: null,
                action: 'request_revision',
                comment: revisionComment.trim(),
                createdAt: new Date().toISOString(),
              },
              ...(existing.auditLogs ?? []),
            ],
          });
        }
        return next;
      });
      setRevisionComment('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Error al solicitar cambios');
    } finally {
      setActionLoading(null);
    }
  }, [clientId, productCode, revisionComment]);

  const toggleExpand = useCallback((stepKey: string) => {
    setExpandedStep((prev) => (prev === stepKey ? null : stepKey));
    setActionError(null);
    setRevisionComment('');
  }, []);

  if (error === 'database_not_configured') {
    return (
      <div className="card p-6 text-center">
        <p className="text-kairikos-muted">
          La base de datos no está configurada. La revisión de configuración por pasos no está disponible.
        </p>
      </div>
    );
  }

  if (error === 'unauthorized') {
    return (
      <div className="card p-6 text-center">
        <p className="text-kairikos-danger">
          No autorizado. Inicia sesión como operador para ver esta sección.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-kairikos-danger">Error: {error}</p>
      </div>
    );
  }

  if (loading || !steps) {
    return (
      <div className="space-y-3" data-testid="config-review-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <StepSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="card p-6 text-center">
        <p className="text-kairikos-muted">No hay pasos de configuración disponibles.</p>
      </div>
    );
  }

  const groupedSteps = [...steps].sort(
    (a, b) => BLOCK_ORDER[a.block] - BLOCK_ORDER[b.block] || a.number - b.number,
  );

  return (
    <div className="space-y-4" data-testid="config-review">
      <div className="card p-4">
        <div className="grid grid-cols-3 gap-2 text-xs font-medium uppercase tracking-wider text-kairikos-muted">
          <span>Paso</span>
          <span>Estado</span>
          <span className="text-right">Acción</span>
        </div>
      </div>

      {groupedSteps.map((step) => {
        const detail = stepDetails.get(step.key);
        const latestVersion = detail?.versions?.[0];
        const status = latestVersion?.status ?? null;
        const isExpanded = expandedStep === step.key;

        return (
          <div key={step.key} data-testid={`config-step-${step.key}`} className="space-y-0">
            <button
              type="button"
              onClick={() => toggleExpand(step.key)}
              className={`card w-full cursor-pointer p-4 text-left transition-colors hover:bg-kairikos-surface2/50 ${isExpanded ? 'rounded-b-none border-b-0' : ''}`}
              aria-expanded={isExpanded}
              data-testid={`config-step-header-${step.key}`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold
                    ${step.v11Deferred ? 'bg-kairikos-border text-kairikos-muted' : 'bg-kairikos-accent/20 text-kairikos-accent'}`}
                >
                  {step.number}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{step.label}</span>
                    {step.autoConfigured && !step.v11Deferred ? (
                      <span className="pill-muted text-[10px]">Auto</span>
                    ) : null}
                    {step.v11Deferred ? (
                      <span className="pill-muted text-[10px]">Próximamente</span>
                    ) : null}
                    {latestVersion?.activeForBot ? (
                      <span className="pill-success text-[10px]">Activo</span>
                    ) : null}
                  </div>
                  <p className="text-xs text-kairikos-muted">{BLOCK_LABEL[step.block]}</p>
                </div>
                <StatusBadge status={status} />
                <span className={`text-kairikos-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                  ▾
                </span>
              </div>
            </button>

            {isExpanded && (
              <div
                className="card rounded-t-none border-t-0 p-4"
                data-testid={`config-step-detail-${step.key}`}
              >
                {step.v11Deferred ? (
                  <p className="text-sm text-kairikos-muted">
                    Este paso estará disponible en una versión futura (v1.1).
                  </p>
                ) : detail ? (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">Bloque</span>
                        <p>{BLOCK_LABEL[step.block]}</p>
                      </div>
                      <div>
                        <span className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">
                          {step.requiredForReady ? 'Obligatorio' : 'Opcional'}
                        </span>
                        <p>{step.requiredForReady ? 'Sí' : 'No'}</p>
                      </div>
                      <div>
                        <span className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">Cliente visible</span>
                        <p>{detail.tierView && 'clienteVisibleForTier' in detail.tierView && (detail.tierView as Record<string, unknown>).clienteVisibleForTier ? 'Sí' : 'No (configuración automática)'}</p>
                      </div>
                      <div>
                        <span className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">Versiones</span>
                        <p>{detail.versions.length}</p>
                      </div>
                    </div>

                    {latestVersion ? (
                      <>
                        <PayloadViewer payload={latestVersion.payload} label="Payload actual" />

                        <div className="space-y-1">
                          <p className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">
                            Historial de versiones
                          </p>
                          <div className="space-y-2">
                            {detail.versions.map((v) => (
                              <div
                                key={v.id}
                                className={`rounded border p-2 text-xs ${v.activeForBot ? 'border-kairikos-success/50 bg-kairikos-success/5' : 'border-kairikos-border'}`}
                                data-testid={`config-version-${v.version}`}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold">v{v.version}</span>
                                  <StatusBadge status={v.status} />
                                  {v.activeForBot ? <span className="pill-success">Activo</span> : null}
                                  {v.submittedAt ? (
                                    <span className="text-kairikos-muted">
                                      Enviado: {DATE_FORMAT.format(new Date(v.submittedAt))}
                                    </span>
                                  ) : null}
                                  {v.approvedAt ? (
                                    <span className="text-kairikos-muted">
                                      Aprobado: {DATE_FORMAT.format(new Date(v.approvedAt))}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">
                            Auditoría
                          </p>
                          <AuditTrail logs={detail.auditLogs} versions={detail.versions} />
                        </div>

                        {(status === 'submitted' || status === 'approved' || status === 'draft' || status === 'needs_revision') && !step.v11Deferred ? (
                          <div className="space-y-3 border-t border-kairikos-border pt-4">
                            <p className="text-sm font-medium">Acciones del operador</p>

                            {actionError ? (
                              <p className="text-sm text-kairikos-danger" data-testid="config-action-error">
                                {actionError}
                              </p>
                            ) : null}

                            {status === 'submitted' ? (
                              <button
                                type="button"
                                onClick={() => handleApprove(step.key)}
                                disabled={actionLoading === step.key}
                                className="btn-primary"
                                data-testid="config-btn-approve"
                              >
                                {actionLoading === step.key ? 'Aprobando…' : 'Aprobar paso'}
                              </button>
                            ) : null}

                            <div className="flex flex-col gap-2">
                              <textarea
                                value={revisionComment}
                                onChange={(e) => setRevisionComment(e.target.value)}
                                placeholder="Describe los cambios necesarios…"
                                rows={3}
                                className="input w-full resize-none"
                                data-testid="config-revision-comment"
                                disabled={actionLoading === step.key}
                              />
                              <button
                                type="button"
                                onClick={() => handleRequestRevision(step.key)}
                                disabled={actionLoading === step.key || !revisionComment.trim()}
                                className="btn-ghost self-start"
                                data-testid="config-btn-request-revision"
                              >
                                {actionLoading === step.key ? 'Enviando…' : 'Solicitar cambios'}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {step.v11Deferred ? (
                          <p className="text-xs text-kairikos-muted">No se pueden realizar acciones en este paso.</p>
                        ) : null}
                      </>
                    ) : (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">
                            Historial
                          </p>
                          <p className="text-sm text-kairikos-muted">
                            El cliente aún no ha guardado datos en este paso.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs font-medium uppercase tracking-wider text-kairikos-muted">
                            Auditoría
                          </p>
                          <AuditTrail logs={detail?.auditLogs ?? []} versions={detail?.versions ?? []} />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-kairikos-muted">Cargando detalles…</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
