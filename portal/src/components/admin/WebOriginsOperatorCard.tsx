'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// 21/11/2026 — webs desde las que funciona el widget del chat, vistas y
// editadas por el operador en la ficha del cliente (pestaña Chatbot → Canales).
// Misma lista que edita el cliente en Portal → Canales → Web (WebChannelCard);
// la ruta del operador (PUT /api/admin/portal/clients/[id]/web-origins) firma
// la auditoría con el operador. Vacía = el chat contesta desde cualquier web.
// =============================================================================

export interface WebOriginsOperatorView {
  /** 'active' | 'disabled' */
  status: string;
  allowedOrigins: string[];
  /** Último cambio de la lista, si lo hubo. */
  lastChange: { at: string; actorType: string; actorEmail: string } | null;
}

// Mismo tope que MAX_ALLOWED_ORIGINS de lib/web-widget-origin.ts (que es
// server-only); el servidor vuelve a comprobarlo.
const MAX_ORIGINS = 10;

const ERROR_LABEL: Record<string, string> = {
  invalid_origin: 'Esta dirección no es una web válida',
  too_many_origins: `Como mucho ${MAX_ORIGINS} webs.`,
  invalid_body: 'La lista no es válida.',
  chatbot_not_specified: 'El cliente tiene varios chatbots: elige uno arriba.',
  not_found: 'Este chatbot aún no tiene widget web.',
  unauthorized: 'La sesión de operador ha caducado. Vuelve a entrar.',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Atlantic/Canary' });
}

export function WebOriginsOperatorCard({
  clientId,
  clientProductId,
  embed,
}: {
  clientId: string;
  clientProductId: string | null;
  embed: WebOriginsOperatorView | null;
}) {
  const router = useRouter();
  const [text, setText] = useState((embed?.allowedOrigins ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!embed) {
    return (
      <div className="space-y-1" data-testid="operator-web-origins">
        <h3 className="text-sm font-semibold">Chat web · webs permitidas</h3>
        <p className="text-xs text-kairikos-muted" data-testid="operator-web-origins-none">
          Este chatbot aún no tiene widget web: lo crea el cliente al activarlo en Portal → Canales → Web.
        </p>
      </div>
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > MAX_ORIGINS) {
      setError(ERROR_LABEL.too_many_origins);
      return;
    }
    setBusy(true);
    try {
      const qs = clientProductId ? `?clientProductId=${encodeURIComponent(clientProductId)}` : '';
      const res = await fetch(`/api/admin/portal/clients/${encodeURIComponent(clientId)}/web-origins${qs}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: lines }),
      });
      const detail = await res.json().catch(() => null);
      if (!res.ok) {
        const label = ERROR_LABEL[detail?.error] ?? 'No se pudo guardar la lista.';
        setError(detail?.error === 'invalid_origin' && detail?.value ? `${label}: «${detail.value}».` : label);
        return;
      }
      // Se enseña tal cual quedó guardada: el servidor la normaliza.
      if (Array.isArray(detail?.allowedOrigins)) setText(detail.allowedOrigins.join('\n'));
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  const empty = embed.allowedOrigins.length === 0;

  return (
    <div className="space-y-2" data-testid="operator-web-origins">
      <h3 className="text-sm font-semibold">Chat web · webs permitidas</h3>
      <p className="text-xs text-kairikos-muted">
        Widget {embed.status === 'active' ? 'activo' : 'desactivado'}.{' '}
        {empty
          ? 'Sin lista: el chat contesta desde cualquier web donde se pegue el snippet.'
          : `Solo contesta desde ${embed.allowedOrigins.length === 1 ? 'esta web' : `estas ${embed.allowedOrigins.length} webs`}.`}{' '}
        El cliente ve y edita la misma lista en Portal → Canales → Web. Cada variante cuenta aparte (<code>https://www.x.com</code>{' '}
        y <code>https://x.com</code>); para probar en local, <code>http://localhost:4321</code>.
      </p>
      {embed.lastChange ? (
        <p className="text-xs text-kairikos-muted" data-testid="operator-web-origins-last">
          Último cambio: {formatWhen(embed.lastChange.at)}, por{' '}
          {embed.lastChange.actorType === 'operator' ? `el operador ${embed.lastChange.actorEmail}` : 'el cliente'}.
        </p>
      ) : null}
      <label className="sr-only" htmlFor="operator-web-allowed-origins">
        Webs donde funciona el chat, una por línea
      </label>
      <textarea
        id="operator-web-allowed-origins"
        className="input min-h-[84px] font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder={'https://www.negocio.com\nhttps://negocio.com'}
        spellCheck={false}
        data-testid="operator-web-allowed-origins"
      />
      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert" data-testid="operator-web-origins-error">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={save} disabled={busy} data-testid="operator-web-save-origins">
          {busy ? 'Guardando…' : 'Guardar webs'}
        </button>
        {saved ? (
          <span className="text-xs text-kairikos-muted" role="status" data-testid="operator-web-origins-saved">
            Guardado.
          </span>
        ) : null}
      </div>
    </div>
  );
}
