'use client';

import { useEffect, useRef, useState } from 'react';
import {
  loadFacebookSdk,
  DEFAULT_SDK_VERSION,
  SDK_VERSIONS,
  SDK_LOAD_BLOCKED,
  SDK_LOAD_TIMEOUT,
  type FBLoginResponse,
} from '@/lib/meta-embedded-signup-sdk';
import { COEXISTENCE_SIGNUP_EXTRAS } from '@/lib/meta-signup-extras';

// =============================================================================
// 2026-09-17 — prueba de la ventana de alta de Meta, sin guardar nada.
//
// POR QUÉ EXISTE: el alta de recall devolvía "Función no disponible" y no
// había forma de saber si fallaba la app o la configuración (fallarían los
// dos modos) o solo Coexistence (fallaría solo el segundo, que Meta reserva a
// Tech Providers). Probarlo desde /portal/canales dependía de que el cliente
// de prueba tuviera el chatbot contratado.
//
// QUÉ HACE: abre FB.login con la misma configuración que usa el portal, en
// modo normal (extras.setup) o Coexistence (extras.featureType), y enseña tal
// cual lo que responde Meta: el callback de FB.login y cada mensaje que la
// ventana manda a esta página.
//
// QUÉ NO HACE: no llama a ninguna ruta del portal, no canjea el code y no
// crea ni toca ninguna conexión. Del code solo se enseña que llegó y su
// longitud: canjeado por quien tenga el secreto de la app daría un token.
// =============================================================================

type Mode = 'normal' | 'coexistence';

interface LogEntry {
  at: string;
  source: 'callback' | 'mensaje' | 'sistema';
  text: string;
}

const EXTRAS: Record<Mode, Record<string, unknown>> = {
  normal: { setup: {} },
  coexistence: COEXISTENCE_SIGNUP_EXTRAS,
};

function describeCallback(response: FBLoginResponse): string {
  const code = response.authResponse?.code;
  return JSON.stringify({
    status: response.status ?? null,
    authResponse: response.authResponse
      ? { code: code ? `recibido (${code.length} caracteres, no se muestra)` : null }
      : null,
  });
}

export function MetaSignupDiagnosticPanel({
  appId,
  configId,
  recallConfigId,
}: {
  appId: string | null;
  configId: string | null;
  /** La que usará recall (ver recallSignupConfigId). */
  recallConfigId: string | null;
}) {
  const [overrideConfig, setOverrideConfig] = useState('');
  const [sdkVersion, setSdkVersion] = useState<string>(DEFAULT_SDK_VERSION);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<Mode | null>(null);
  const listening = useRef(false);

  function push(source: LogEntry['source'], text: string) {
    setLog((prev) => [...prev, { at: new Date().toLocaleTimeString('es-ES'), source, text }]);
  }

  useEffect(() => {
    if (listening.current) return;
    listening.current = true;
    function onMessage(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return;
      let text: string;
      try {
        text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      } catch {
        text = String(event.data);
      }
      // Los mensajes del SDK (xd_action, etc.) son ruido; los de la ventana
      // de alta llevan type WA_EMBEDDED_SIGNUP.
      if (!text.includes('WA_EMBEDDED_SIGNUP') && !text.includes('error')) return;
      push('mensaje', text.length > 800 ? `${text.slice(0, 800)}…` : text);
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      listening.current = false;
    };
  }, []);

  const effectiveConfig = (mode: Mode) => overrideConfig.trim() || (mode === 'coexistence' ? recallConfigId : configId);

  async function run(mode: Mode) {
    const config = effectiveConfig(mode);
    if (!appId || !config) {
      push('sistema', 'Falta el App ID o la configuración: guárdalos arriba primero.');
      return;
    }
    setBusy(mode);
    push(
      'sistema',
      `Abriendo ventana · modo ${mode === 'normal' ? 'normal' : 'Coexistence'} · SDK ${sdkVersion} · app ${appId} · config ${config} · extras ${JSON.stringify(EXTRAS[mode])}`,
    );
    try {
      await loadFacebookSdk(appId, sdkVersion);
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      push(
        'sistema',
        reason === SDK_LOAD_BLOCKED
          ? 'El navegador no dejó cargar el script de Facebook (connect.facebook.net). Suele ser un bloqueador de anuncios o una extensión de privacidad: desactívala para esta página.'
          : reason === SDK_LOAD_TIMEOUT
            ? 'El script de Facebook no terminó de cargar en 15 s. Revisa la conexión o las extensiones del navegador.'
            : `Error al cargar el SDK: ${reason || 'desconocido'}`,
      );
      setBusy(null);
      return;
    }
    if (!window.FB) {
      push('sistema', 'El SDK de Facebook no está disponible tras cargarlo.');
      setBusy(null);
      return;
    }
    push('sistema', `SDK de Facebook listo (${sdkVersion}). Pidiendo a Meta que abra la ventana…`);

    // Solo en esta página de prueba: se envuelve window.open durante la
    // llamada para saber si el SDK intentó abrir la ventana y si el
    // navegador la bloqueó (window.open devuelve null).
    const originalOpen = window.open;
    let popupAttempted = false;
    window.open = function patchedOpen(...args: Parameters<typeof window.open>) {
      popupAttempted = true;
      const win = originalOpen.apply(window, args);
      push(
        'sistema',
        win
          ? 'El navegador abrió la ventana de Meta. Si no la ves, búscala detrás de esta o en la barra de tareas.'
          : 'El navegador BLOQUEÓ la ventana emergente. Permite las ventanas emergentes para este sitio (candado de la barra de direcciones) y vuelve a probar.',
      );
      return win;
    } as typeof window.open;

    let answered = false;
    const silence = setTimeout(() => {
      if (answered) return;
      push(
        'sistema',
        popupAttempted
          ? 'Sin respuesta de Meta tras 20 s: la ventana sigue abierta (normal si espera a que inicies sesión). Al cerrarla aparecerá el callback.'
          : 'Sin respuesta tras 20 s y el SDK no intentó abrir ninguna ventana. Mira la consola del navegador (F12): si pone «exceeded the rate limit», Meta ha limitado los intentos por hacer muchas pruebas seguidas; espera al menos 30–60 minutos antes de volver a probar.',
      );
    }, 20_000);

    try {
      window.FB.login(
        (response) => {
          answered = true;
          clearTimeout(silence);
          push('callback', describeCallback(response));
          setBusy(null);
        },
        {
          config_id: config,
          response_type: 'code',
          override_default_response_type: true,
          extras: EXTRAS[mode],
        },
      );
    } catch (err) {
      clearTimeout(silence);
      push('sistema', `FB.login lanzó un error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(null);
    } finally {
      window.open = originalOpen;
    }
    if (!popupAttempted) {
      push('sistema', 'El SDK no intentó abrir una ventana durante la llamada.');
    }
  }

  return (
    <section className="card space-y-4" aria-label="Probar la ventana de Meta" data-testid="meta-signup-diagnostic">
      <div>
        <h2 className="text-lg font-semibold">Probar la ventana de alta de Meta</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Abre la misma ventana que ven los clientes y enseña lo que responde Meta. <strong>No guarda nada</strong>{' '}
          ni toca ninguna conexión: puedes completarla o cerrarla sin consecuencias.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-kairikos-muted">
          <li>
            <strong>Fallan los dos modos</strong> → el problema es la app o la configuración.
          </li>
          <li>
            <strong>Solo falla Coexistence</strong> → Meta no permite Coexistence a esta app (requisito de Tech
            Provider).
          </li>
        </ul>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <p>
          <span className="text-kairikos-muted">App ID: </span>
          <span className="font-mono">{appId ?? '—'}</span>
        </p>
        <p>
          <span className="text-kairikos-muted">Config chatbot: </span>
          <span className="font-mono">{configId ?? '—'}</span>
        </p>
        <p>
          <span className="text-kairikos-muted">Config recall: </span>
          <span className="font-mono">{recallConfigId ?? '—'}</span>
        </p>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Versión del SDK de Facebook</span>
        <select
          className="input w-full sm:max-w-xs"
          value={sdkVersion}
          onChange={(e) => setSdkVersion(e.target.value)}
          data-testid="meta-diagnostic-sdk-version"
        >
          {SDK_VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
              {v === DEFAULT_SDK_VERSION ? ' (la que usan los clientes)' : ''}
            </option>
          ))}
        </select>
        <span className="block text-xs text-kairikos-muted">
          Si con una versión más nueva la ventana sí arranca, el portal tiene que pasar a usarla.
        </span>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Probar con otra configuración (opcional)</span>
        <input
          className="input w-full font-mono sm:max-w-xs"
          value={overrideConfig}
          onChange={(e) => setOverrideConfig(e.target.value)}
          placeholder="config_id"
          inputMode="numeric"
          data-testid="meta-diagnostic-config"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null}
          onClick={() => run('normal')}
          data-testid="meta-diagnostic-normal"
        >
          {busy === 'normal' ? 'Ventana abierta…' : 'Probar modo normal'}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null}
          onClick={() => run('coexistence')}
          data-testid="meta-diagnostic-coexistence"
        >
          {busy === 'coexistence' ? 'Ventana abierta…' : 'Probar modo Coexistence (recall)'}
        </button>
        {busy ? (
          <button type="button" className="btn-ghost" onClick={() => setBusy(null)}>
            Desbloquear botones
          </button>
        ) : null}
        {log.length > 0 ? (
          <button type="button" className="btn-ghost" onClick={() => setLog([])}>
            Limpiar
          </button>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Lo que ha respondido Meta</h3>
        {log.length === 0 ? (
          <p className="text-sm text-kairikos-muted">Todavía nada. Pulsa uno de los botones.</p>
        ) : (
          <ol className="space-y-1 overflow-x-auto font-mono text-xs" data-testid="meta-diagnostic-log">
            {log.map((entry, i) => (
              <li key={i} className="whitespace-pre-wrap break-all rounded-lg bg-kairikos-surface2 px-2 py-1">
                <span className="text-kairikos-muted">
                  {entry.at} · {entry.source}:
                </span>{' '}
                {entry.text}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-kairikos-muted">
          Si Meta muestra un error dentro de su ventana (como “Función no disponible”), anótalo tal cual: a veces no
          llega ningún mensaje a esta página, y el callback vuelve con <code>authResponse: null</code>.
        </p>
      </div>
    </section>
  );
}
