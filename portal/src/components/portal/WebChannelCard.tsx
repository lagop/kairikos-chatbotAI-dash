'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Canales Fase 4 — tarjeta "Web" en /portal/canales. A diferencia de
// Telegram/Meta (autorizar una credencial de terceros), acá "conectar"
// es activar el propio widget de Kairikos: generar un publicToken y
// mostrar el snippet a pegar en el sitio del cliente. Snippet apunta al
// origin actual (window.location.origin) — el widget se sirve desde el
// propio portal (public/widget/embed.js), no hay dominio aparte que
// configurar.
// =============================================================================

export interface WebEmbedSummary {
  publicToken: string;
  status: 'active' | 'disabled';
  primaryColor: string;
  position: 'bottom-right' | 'bottom-left';
}

const ERROR_LABEL: Record<string, string> = {
  channel_not_in_plan: 'El widget Web no está incluido en tu plan actual.',
  forbidden: 'Este producto no está disponible ahora mismo.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
  invalid_body: 'Color u posición inválidos.',
};

export function WebChannelCard({ embed, allowed }: { embed: WebEmbedSummary | null; allowed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [color, setColor] = useState(embed?.primaryColor ?? '#0E6B5E');
  const [position, setPosition] = useState<'bottom-right' | 'bottom-left'>(embed?.position ?? 'bottom-right');

  const isActive = embed?.status === 'active';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = embed
    ? `<script src="${origin}/widget/embed.js" data-space-token="${embed.publicToken}"></script>`
    : '';

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/web/enable', { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo activar el widget.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/web/disable', { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo desactivar el widget.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAppearance() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/web', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ primaryColor: color, position }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar la apariencia.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar — selecciona el texto manualmente.');
    }
  }

  return (
    <div className="card space-y-3" data-testid="web-channel-card" data-status={embed?.status ?? 'disconnected'}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Web</h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Añade la burbuja de chat de Kairikos a tu propia web con un snippet.
          </p>
        </div>
        {isActive ? <span className="pill-success">Activo</span> : null}
      </div>

      {!allowed ? (
        <p className="text-sm text-kairikos-muted" data-testid="web-locked">
          El widget Web no está incluido en tu plan actual. Contacta con soporte para ampliar tu plan de chatbot.
        </p>
      ) : !embed || !isActive ? (
        <>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="web-error">
              {error}
            </p>
          ) : null}
          <button type="button" className="btn-primary" onClick={enable} disabled={busy} data-testid="web-enable-button">
            {busy ? 'Activando…' : 'Activar widget'}
          </button>
        </>
      ) : (
        <>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="web-error">
              {error}
            </p>
          ) : null}

          <div>
            <p className="label">Snippet para tu web</p>
            <pre
              className="overflow-x-auto rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 text-xs"
              data-testid="web-snippet"
            >
              {snippet}
            </pre>
            <button type="button" className="btn-ghost mt-2" onClick={copySnippet} data-testid="web-copy-snippet">
              {copied ? 'Copiado ✓' : 'Copiar snippet'}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-kairikos-border pt-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-kairikos-muted">Color principal</span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-16 cursor-pointer rounded border border-kairikos-border"
                data-testid="web-color-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-kairikos-muted">Posición</span>
              <select
                className="input"
                value={position}
                onChange={(e) => setPosition(e.target.value as 'bottom-right' | 'bottom-left')}
                data-testid="web-position-select"
              >
                <option value="bottom-right">Abajo a la derecha</option>
                <option value="bottom-left">Abajo a la izquierda</option>
              </select>
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={saveAppearance}
              disabled={busy}
              data-testid="web-save-appearance"
            >
              {busy ? 'Guardando…' : 'Guardar'}
            </button>
          </div>

          <button type="button" className="btn-ghost" onClick={disable} disabled={busy} data-testid="web-disable-button">
            {busy ? 'Desactivando…' : 'Desactivar widget'}
          </button>
        </>
      )}
    </div>
  );
}
