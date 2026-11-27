'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { withChatbot } from '@/lib/wizard-url';
import { buildWidgetSnippet } from '@/lib/web-widget-snippet';

// =============================================================================
// Canales Fase 4 — tarjeta "Web" en /portal/canales. A diferencia de
// Telegram/Meta (autorizar una credencial de terceros), acá "conectar"
// es activar el propio widget de Kairikos: generar un publicToken y
// mostrar el snippet a pegar en el sitio del cliente. Snippet apunta al
// origin actual (window.location.origin) — el widget se sirve desde el
// propio portal (public/widget/embed.v2.js desde el 27/11/2026; antes
// embed.js), no hay dominio aparte que configurar.
// =============================================================================

// 05/10/2026 — el origin se lee con useSyncExternalStore y no con
// `typeof window` en el render: el servidor pintaba `src="/widget/embed.js"`
// y el navegador `src="https://…/widget/embed.js"`, y React tiraba un error
// de hidratación en /portal/canales y regeneraba la página entera en el
// cliente. Así el servidor y la hidratación ven '' y el origin real llega en
// el render siguiente. No se calcula en el servidor a propósito: detrás del
// proxy el contenedor se ve a sí mismo como 0.0.0.0:3000 (ver
// lib/public-origin.ts) y el origin del navegador es justo el que hay que pegar.
const noopSubscribe = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => '';

export interface WebEmbedSummary {
  publicToken: string;
  status: 'active' | 'disabled';
  primaryColor: string;
  position: 'bottom-right' | 'bottom-left';
  /** Webs desde las que funciona el widget (16/11/2026). Vacía = cualquiera. */
  allowedOrigins: string[];
}

const ERROR_LABEL: Record<string, string> = {
  channel_not_in_plan: 'El widget Web no está incluido en tu plan actual.',
  forbidden: 'Este producto no está disponible ahora mismo.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
  invalid_body: 'Color u posición inválidos.',
};

// Mismo tope que MAX_ALLOWED_ORIGINS de lib/web-widget-origin.ts, repetido
// aquí porque un componente de cliente no importa libs del servidor. El
// servidor es quien valida de verdad; esto solo evita un viaje en balde.
const MAX_ORIGINS = 10;

const ORIGINS_ERROR_LABEL: Record<string, string> = {
  invalid_origin: 'Esta dirección no es una web válida',
  too_many_origins: `Como mucho ${MAX_ORIGINS} webs.`,
  invalid_body: 'La lista no es válida.',
};

export function WebChannelCard({
  embed,
  allowed,
  clientProductId = null,
  privacyUrlMissing = false,
}: {
  embed: WebEmbedSummary | null;
  allowed: boolean;
  /** 25/11/2026 — el paso 10 aprobado no da URL de política de privacidad,
   *  así que el formulario de contacto del chat sale sin enlace (salvo que la
   *  web ponga data-privacy-url en el <script> de v2, que el portal no ve). */
  privacyUrlMissing?: boolean;
  /** Fase 4 multi-instancia — de qué chatbot es el canal. Null con uno
   *  solo: las llamadas son las de siempre. */
  clientProductId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [color, setColor] = useState(embed?.primaryColor ?? '#0E6B5E');
  const [position, setPosition] = useState<'bottom-right' | 'bottom-left'>(embed?.position ?? 'bottom-right');
  const [originsText, setOriginsText] = useState((embed?.allowedOrigins ?? []).join('\n'));
  const [originsError, setOriginsError] = useState<string | null>(null);
  const [originsSaved, setOriginsSaved] = useState(false);

  // El aviso de la portada (WidgetOriginsNotice) enlaza a #webs-permitidas. El
  // salto al ancla que hace Next llega antes de que la página termine de
  // pintarse y se pasaba de largo (probado en local, 21/11/2026): se repite
  // aquí, ya montada la tarjeta.
  useEffect(() => {
    if (window.location.hash !== '#webs-permitidas') return;
    const frame = requestAnimationFrame(() => document.getElementById('webs-permitidas')?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, []);

  const isActive = embed?.status === 'active';
  const origin = useSyncExternalStore(noopSubscribe, browserOrigin, serverOrigin);
  // v2 desde el 27/11/2026: el v1 no tiene casilla de consentimiento en su
  // formulario de contacto. Ver lib/web-widget-snippet.ts.
  const snippet = embed ? buildWidgetSnippet(origin, embed.publicToken) : '';

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(withChatbot('/api/portal/channels/web/enable', clientProductId), { method: 'POST' });
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
      const res = await fetch(withChatbot('/api/portal/channels/web/disable', clientProductId), { method: 'POST' });
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
      const res = await fetch(withChatbot('/api/portal/channels/web', clientProductId), {
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

  async function saveOrigins() {
    setOriginsError(null);
    setOriginsSaved(false);
    const lines = originsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > MAX_ORIGINS) {
      setOriginsError(ORIGINS_ERROR_LABEL.too_many_origins);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(withChatbot('/api/portal/channels/web/origins', clientProductId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: lines }),
      });
      const detail = await res.json().catch(() => null);
      if (!res.ok) {
        const label = ORIGINS_ERROR_LABEL[detail?.error] ?? ERROR_LABEL[detail?.error] ?? 'No se pudo guardar la lista.';
        setOriginsError(detail?.error === 'invalid_origin' && detail?.value ? `${label}: «${detail.value}».` : label);
        return;
      }
      // El servidor la devuelve normalizada («www.x.com/contacto» →
      // «https://www.x.com»): se enseña tal cual quedó guardada.
      if (Array.isArray(detail?.allowedOrigins)) setOriginsText(detail.allowedOrigins.join('\n'));
      setOriginsSaved(true);
      router.refresh();
    } catch (err) {
      setOriginsError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
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

          {privacyUrlMissing ? (
            <p
              className="rounded-lg bg-kairikos-warning/15 p-3 text-sm text-kairikos-text"
              data-testid="web-privacy-missing"
            >
              Falta la dirección de tu política de privacidad: el paso 10 (Cumplimiento) no está completo o aún
              no está aprobado. Mientras tanto, el formulario donde los visitantes dejan su teléfono o correo
              sale con el aviso de privacidad pero sin enlace a tu política.{' '}
              <a href={withChatbot('/portal/wizard/chatbot/10', clientProductId)} className="font-semibold underline">
                Completar el paso 10
              </a>
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

          {/* id: destino del aviso de la portada (WidgetOriginsNotice). */}
          <div id="webs-permitidas" className="scroll-mt-24 space-y-2 border-t border-kairikos-border pt-3">
            <label className="block text-xs font-medium text-kairikos-muted" htmlFor="web-allowed-origins">
              Webs donde funciona el chat
            </label>
            <p className="text-xs text-kairikos-muted">
              Una por línea, por ejemplo <code>https://www.tunegocio.com</code>. Si la dejas vacía, el chat funciona en
              cualquier web donde se pegue el snippet. Si pones alguna, solo en esas: así nadie puede copiar tu snippet a
              otra web y gastar tus mensajes del mes.
            </p>
            <textarea
              id="web-allowed-origins"
              className="input min-h-[84px] font-mono text-xs"
              value={originsText}
              onChange={(e) => {
                setOriginsText(e.target.value);
                setOriginsSaved(false);
              }}
              placeholder={'https://www.tunegocio.com\nhttps://tunegocio.com'}
              spellCheck={false}
              data-testid="web-allowed-origins"
            />
            {originsError ? (
              <p className="text-sm text-kairikos-danger" data-testid="web-origins-error">
                {originsError}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="btn-primary"
                onClick={saveOrigins}
                disabled={busy}
                data-testid="web-save-origins"
              >
                {busy ? 'Guardando…' : 'Guardar webs'}
              </button>
              {originsSaved ? (
                <span className="text-sm text-kairikos-muted" data-testid="web-origins-saved">
                  Guardado ✓
                </span>
              ) : null}
            </div>
          </div>

          <button type="button" className="btn-ghost" onClick={disable} disabled={busy} data-testid="web-disable-button">
            {busy ? 'Desactivando…' : 'Desactivar widget'}
          </button>
        </>
      )}
    </div>
  );
}
