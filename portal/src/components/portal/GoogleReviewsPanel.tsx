'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP-22a — the interactive half of /portal/resenas for a client with the
// 'reviews' product contracted: connect/reconnect CTA (a plain link to
// the WP-21 OAuth start route — that flow is a full-page redirect, not a
// fetch), and, once connected, "Sincronizar ahora" / "Desconectar".
// =============================================================================

export type ConnectionStatus = 'not_connected' | 'active' | 'needs_reconnect' | 'revoked';

export interface GoogleReviewsPanelProps {
  connectionId: string | null;
  status: ConnectionStatus;
  locationName: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  autoPublishReplies: boolean;
  autoPublishRepliesChangedAt: string | null;
}

const OAUTH_START_HREF = '/api/portal/google-business/oauth/start';

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export function GoogleReviewsPanel({
  connectionId,
  status,
  locationName,
  lastSyncAt,
  lastSyncError,
  autoPublishReplies,
  autoPublishRepliesChangedAt,
}: GoogleReviewsPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<'sync' | 'disconnect' | 'auto-publish' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  async function toggleAutoPublish() {
    setBusy('auto-publish');
    setMessage(null);
    try {
      const res = await fetch('/api/portal/google-business/connection/auto-publish', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoPublishReplies }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage({ kind: 'error', text: `No se pudo cambiar el ajuste. ${data?.error ?? res.statusText}` });
        return;
      }
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync');
    setMessage(null);
    try {
      const res = await fetch('/api/portal/google-business/sync', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        setMessage({ kind: 'info', text: 'Ya se sincronizó hace poco — inténtalo de nuevo más tarde.' });
      } else if (!res.ok) {
        setMessage({ kind: 'error', text: `No se pudo sincronizar. ${data?.error ?? res.statusText}` });
      } else {
        setMessage({ kind: 'success', text: `Sincronizado — ${data?.reviewCount ?? 0} reseñas.` });
        router.refresh();
      }
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!connectionId) return;
    setBusy('disconnect');
    setMessage(null);
    try {
      const res = await fetch('/api/portal/google-business/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage({ kind: 'error', text: `No se pudo desconectar. ${data?.error ?? res.statusText}` });
        return;
      }
      setMessage({ kind: 'success', text: 'Cuenta de Google desconectada.' });
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Conexión con Google" data-testid="google-reviews-panel">
      {message ? (
        <div
          role="status"
          data-testid="google-reviews-panel-message"
          className={
            message.kind === 'success'
              ? 'rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success'
              : message.kind === 'error'
                ? 'rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger'
                : 'rounded-xl border border-kairikos-accent/40 bg-kairikos-accent/10 px-4 py-3 text-sm'
          }
        >
          {message.text}
        </div>
      ) : null}

      {status === 'not_connected' ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-kairikos-muted">
            Conecta tu ficha de Google Business Profile para ver y gestionar tus reseñas desde el portal.
          </p>
          <a href={OAUTH_START_HREF} className="btn-primary" data-testid="google-reviews-connect">
            Conectar con Google
          </a>
        </div>
      ) : null}

      {status === 'needs_reconnect' ? (
        <div className="flex flex-col items-start gap-3">
          <div className="rounded-xl border border-kairikos-warning/40 bg-kairikos-warning/10 px-4 py-3 text-sm">
            <p className="font-semibold">Reconexión necesaria</p>
            <p className="mt-1 text-kairikos-muted">
              Google ha revocado o caducado el acceso a {locationName ?? 'tu ficha'}. Reconecta tu cuenta para
              seguir sincronizando reseñas.
            </p>
          </div>
          <a href={OAUTH_START_HREF} className="btn-primary" data-testid="google-reviews-reconnect">
            Reconectar con Google
          </a>
        </div>
      ) : null}

      {status === 'revoked' ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-kairikos-muted">Desconectaste tu cuenta de Google. Puedes volver a conectarla cuando quieras.</p>
          <a href={OAUTH_START_HREF} className="btn-primary" data-testid="google-reviews-connect">
            Conectar con Google
          </a>
        </div>
      ) : null}

      {status === 'active' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{locationName}</p>
            <p className="text-xs text-kairikos-muted" data-testid="google-reviews-last-sync">
              Última sincronización: {formatRelative(lastSyncAt)}
              {lastSyncError ? ' · hubo un problema en el último intento' : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={syncNow}
              disabled={busy !== null}
              data-testid="google-reviews-sync-now"
            >
              {busy === 'sync' ? 'Sincronizando…' : 'Sincronizar ahora'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={disconnect}
              disabled={busy !== null}
              data-testid="google-reviews-disconnect"
            >
              {busy === 'disconnect' ? 'Desconectando…' : 'Desconectar'}
            </button>
          </div>
        </div>
      ) : null}

      {status === 'active' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kairikos-border pt-4">
          <div>
            <p className="text-sm font-semibold">Respuestas automáticas con IA</p>
            <p className="text-xs text-kairikos-muted">
              {autoPublishReplies
                ? 'Las reseñas nuevas sin respuesta se responden automáticamente.'
                : 'Cada respuesta generada por IA espera tu aprobación antes de publicarse.'}
              {autoPublishRepliesChangedAt
                ? ` · último cambio ${formatRelative(autoPublishRepliesChangedAt)}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className={autoPublishReplies ? 'btn-primary' : 'btn-ghost'}
            onClick={toggleAutoPublish}
            disabled={busy !== null}
            aria-pressed={autoPublishReplies}
            data-testid="google-reviews-auto-publish-toggle"
          >
            {busy === 'auto-publish' ? 'Guardando…' : autoPublishReplies ? 'Activado' : 'Desactivado'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
