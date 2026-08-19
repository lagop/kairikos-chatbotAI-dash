'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP: conexión de canales — Fase 3. WhatsApp Embedded Signup + Meta
// Business Login for Messenger/Instagram, in one flow.
//
// UNVERIFIED AGAINST A REAL META APP — there is no META_APP_ID/
// META_CONFIG_ID configured anywhere this environment had access to, so
// this has never actually opened Meta's popup. Built to Meta's
// documented, stable SDK contract (window.FB.login with a config_id,
// the WA_EMBEDDED_SIGNUP postMessage event) as closely as possible —
// the first real signup attempt against a live Meta App is the real
// test this code hasn't had. Everything server-side of the `code` this
// component receives (channel-webhook.test.ts, channels-meta-
// routes.test.ts, meta-business.test.ts) IS covered by real tests.
//
// Why no npm SDK: Meta ships this as a plain <script> (connect.facebook.
// net/en_US/sdk.js) that exposes a global `window.FB` — there's no
// first-party npm package for it, matching the fetch-direct convention
// the rest of this portal's third-party integrations already use.
// =============================================================================

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

type MetaChannel = 'whatsapp' | 'messenger' | 'instagram';

export interface MetaConnectionSummary {
  id: string;
  channel: MetaChannel;
  externalId: string;
  label: string | null;
  status: 'active' | 'needs_reconnect' | 'revoked';
}

const CHANNEL_LABEL: Record<MetaChannel, string> = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

const ERROR_LABEL: Record<string, string> = {
  channel_not_in_plan: 'Ninguno de los canales de Meta está incluido en tu plan actual.',
  forbidden: 'Este producto no está disponible ahora mismo.',
  meta_api_error: 'No se pudo completar la conexión con Meta. Intenta de nuevo en un momento.',
  no_surfaces_connected: 'No se encontró ninguna Página o número que se pueda conectar con tu plan actual.',
  not_configured: 'La conexión con Meta no está disponible ahora mismo.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
};

interface FBLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

declare global {
  interface Window {
    FB?: {
      init: (opts: { appId: string; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: FBLoginResponse) => void,
        opts: {
          config_id: string;
          response_type: 'code';
          override_default_response_type: true;
          extras?: Record<string, unknown>;
        },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  return new Promise((resolve) => {
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, xfbml: false, version: 'v21.0' });
      resolve();
    };
    if (document.getElementById('facebook-jssdk')) return;
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  });
}

export function MetaChannelCard({
  metaAppId,
  metaConfigId,
  connections,
  allowedChannels,
}: {
  metaAppId: string | null;
  metaConfigId: string | null;
  connections: MetaConnectionSummary[];
  allowedChannels: string[];
}) {
  const router = useRouter();
  const listId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured from Meta's WA_EMBEDDED_SIGNUP postMessage event while the
  // popup is open — arrives before FB.login()'s own callback fires.
  const whatsappSignup = useRef<{ wabaId: string; phoneNumberId: string } | null>(null);

  const metaAllowed = allowedChannels.some((c) => c === 'whatsapp' || c === 'messenger' || c === 'instagram');
  const configured = Boolean(metaAppId && metaConfigId);
  const active = connections.filter((c) => c.status === 'active');

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://www.facebook.com') return;
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const payload = data as { type?: string; event?: string; data?: { waba_id?: string; phone_number_id?: string } };
      if (payload.type === 'WA_EMBEDDED_SIGNUP' && payload.event === 'FINISH' && payload.data?.waba_id && payload.data?.phone_number_id) {
        whatsappSignup.current = { wabaId: payload.data.waba_id, phoneNumberId: payload.data.phone_number_id };
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  async function connect() {
    if (!metaAppId || !metaConfigId) return;
    setError(null);
    setBusy(true);
    whatsappSignup.current = null;
    try {
      await loadFacebookSdk(metaAppId);
      window.FB?.login(
        (response) => {
          void (async () => {
            const code = response.authResponse?.code;
            if (!code) {
              setError('No se pudo completar la conexión — se cerró la ventana antes de terminar.');
              setBusy(false);
              return;
            }
            try {
              const res = await fetch('/api/portal/channels/meta/complete-signup', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code, whatsapp: whatsappSignup.current ?? undefined }),
              });
              if (!res.ok) {
                const detail = await res.json().catch(() => null);
                setError(ERROR_LABEL[detail?.error] ?? 'No se pudo conectar con Meta.');
                setBusy(false);
                return;
              }
              router.refresh();
            } catch (err) {
              setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
              setBusy(false);
            }
          })();
        },
        {
          config_id: metaConfigId,
          response_type: 'code',
          override_default_response_type: true,
        },
      );
    } catch (err) {
      setError(`No se pudo cargar el SDK de Meta: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  async function disconnect(connectionId: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/meta/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo desconectar el canal.');
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3" data-testid="meta-channel-card">
      <div>
        <h2 className="text-lg font-semibold">WhatsApp, Messenger e Instagram</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Conecta tu chatbot a través de tu cuenta de Meta Business — un solo paso para los tres canales.
        </p>
      </div>

      {!metaAllowed ? (
        <p className="text-sm text-kairikos-muted" data-testid="meta-locked">
          Ninguno de estos canales está incluido en tu plan actual. Contacta con soporte para ampliar tu plan de
          chatbot.
        </p>
      ) : !configured ? (
        <p className="text-sm text-kairikos-muted" data-testid="meta-not-configured">
          La conexión con Meta todavía no está disponible. Contacta con soporte.
        </p>
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="space-y-2" id={listId} data-testid="meta-connections">
              {active.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-kairikos-border px-3 py-2"
                  data-testid="meta-connection-item"
                  data-channel={c.channel}
                >
                  <span className="text-sm text-kairikos-text">
                    <span className="font-semibold">{CHANNEL_LABEL[c.channel]}</span> — {c.label ?? c.externalId}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => disconnect(c.id)}
                    disabled={busy}
                    data-testid="meta-disconnect-button"
                  >
                    Desconectar
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="meta-error">
              {error}
            </p>
          ) : null}

          <button type="button" className="btn-primary" onClick={connect} disabled={busy} data-testid="meta-connect-button">
            {busy ? 'Conectando…' : active.length > 0 ? 'Conectar otra cuenta de Meta' : 'Conectar con Meta'}
          </button>
        </>
      )}
    </div>
  );
}
