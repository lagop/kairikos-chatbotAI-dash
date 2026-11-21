'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Ficha del cliente (operador) → Canales → «Widget web: webs permitidas»
// (21/11/2026). La misma lista que el cliente edita en Portal → Canales → Web:
// las webs desde las que contesta su chat. Vacía = cualquiera.
//
// Existe para no tener que tocar producción con SQL cuando el cliente no entra
// en su portal o es una demo nuestra (Alisio, 17/11/2026). Guarda por
// PUT /api/admin/portal/clients/[id]/web-widget-origins, que deja la fila de
// auditoría a nombre del operador; aquí se enseñan los últimos cambios para que
// se vea quién la tocó, cliente u operador.
//
// La validación de verdad es del servidor (lib/web-widget-origin.ts); aquí solo
// se repite el tope para no hacer un viaje en balde: un componente de cliente
// no importa libs del servidor.
// =============================================================================

const MAX_ORIGINS = 10;

export interface WebWidgetOriginsEmbed {
  status: string;
  allowedOrigins: string[];
}

export interface WebWidgetOriginsChange {
  id: string;
  changedAt: string;
  actorType: string;
  actorEmail: string | null;
  after: string[];
}

const ERROR_LABEL: Record<string, string> = {
  invalid_origin: 'Esta dirección no es una web válida',
  too_many_origins: `Como mucho ${MAX_ORIGINS} webs.`,
  invalid_body: 'La lista no es válida.',
  not_found: 'Este chatbot no tiene widget web.',
  chatbot_not_specified: 'El cliente tiene varios chatbots: elige uno arriba.',
  unauthorized: 'La sesión de operador ha caducado.',
  service_unavailable: 'Base de datos no disponible.',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function actorLabel(change: WebWidgetOriginsChange): string {
  if (change.actorType === 'operator') return change.actorEmail ? `Operador (${change.actorEmail})` : 'Operador';
  return 'El cliente';
}

export function WebWidgetOriginsCard({
  clientId,
  clientProductId,
  embed,
  history,
}: {
  clientId: string;
  /** Null con un solo chatbot: la ruta encuentra el único widget. */
  clientProductId: string | null;
  embed: WebWidgetOriginsEmbed | null;
  history: WebWidgetOriginsChange[];
}) {
  const router = useRouter();
  const [text, setText] = useState((embed?.allowedOrigins ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!embed) {
    return (
      <div className="rounded-lg border border-kairikos-border p-4" data-testid="admin-web-origins">
        <h3 className="text-sm font-semibold">Widget web: webs permitidas</h3>
        <p className="mt-1 text-sm text-kairikos-muted">Este chatbot no tiene el widget web activado.</p>
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
      const res = await fetch(`/api/admin/portal/clients/${encodeURIComponent(clientId)}/web-widget-origins${qs}`, {
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
      if (Array.isArray(detail?.allowedOrigins)) setText(detail.allowedOrigins.join('\n'));
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  const restricted = embed.allowedOrigins.length > 0;

  return (
    <div className="space-y-3 rounded-lg border border-kairikos-border p-4" data-testid="admin-web-origins">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Widget web: webs permitidas</h3>
          <p className="mt-1 text-xs text-kairikos-muted">
            Una por línea. Vacía: el chat contesta en cualquier web donde se pegue el snippet. Con alguna, solo en esas
            (hay que poner cada variante: con y sin www, y el puerto en local). El cliente ve y puede cambiar la misma
            lista desde su portal.
          </p>
        </div>
        <span className={restricted ? 'pill-success' : 'pill-muted'} data-testid="admin-web-origins-state">
          {restricted ? `Limitado a ${embed.allowedOrigins.length}` : 'Cualquier web'}
        </span>
      </div>

      {embed.status !== 'active' ? (
        <p className="text-xs text-kairikos-muted">El widget está desactivado ahora mismo: la lista se aplicará si lo vuelve a activar.</p>
      ) : null}

      <label className="sr-only" htmlFor="admin-web-origins-input">
        Webs permitidas
      </label>
      <textarea
        id="admin-web-origins-input"
        className="input min-h-[84px] w-full font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder={'https://www.negocio.com\nhttps://negocio.com'}
        spellCheck={false}
        data-testid="admin-web-origins-input"
      />
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="admin-web-origins-error">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={save} disabled={busy} data-testid="admin-web-origins-save">
          {busy ? 'Guardando…' : 'Guardar webs'}
        </button>
        {saved ? <span className="text-sm text-kairikos-muted">Guardado ✓</span> : null}
      </div>

      {history.length > 0 ? (
        <div className="border-t border-kairikos-border pt-3">
          <p className="text-xs font-medium text-kairikos-muted">Últimos cambios</p>
          <ul className="mt-1 space-y-1 text-xs" data-testid="admin-web-origins-history">
            {history.map((change) => (
              <li key={change.id}>
                <span className="text-kairikos-muted">{DATE_FMT.format(new Date(change.changedAt))}</span> · {actorLabel(change)}
                {' → '}
                {change.after.length > 0 ? change.after.join(', ') : 'sin restricción'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
