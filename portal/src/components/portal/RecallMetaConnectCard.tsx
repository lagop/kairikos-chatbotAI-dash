'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { COEXISTENCE_SIGNUP_EXTRAS } from '@/lib/meta-signup-extras';
import { loadFacebookSdk, describeSdkLoadError, type FBLoginResponse } from '@/lib/meta-embedded-signup-sdk';

// =============================================================================
// Fase 8 ('recall') — the client-facing half of the Coexistence connect.
//
// A dedicated component rather than a `coexistence` prop bolted onto
// MetaChannelCard: that card's shape (a LIST of connections across three
// channels, chatbot-tier "not in your plan" messaging, per-item
// disconnect) answers a different question than this one does — recall
// binds exactly ONE WhatsApp number to exactly ONE subscription, and
// there is no disconnect here (Coexistence stays bound for the life of
// the subscription; a reconnect after a token expiry re-runs `connect`,
// it does not disconnect first). Forcing both flows through one
// component would mean branching most of its render on which flow it is
// — the same reasoning that gave recall its own numbers/audit/queue
// modules instead of reusing chatbot's. See recall-meta.ts's header.
//
// Rendered from /portal/llamadas's onboarding view — NOT a pure
// self-serve button despite living on a page whose header comment says
// "read-only on purpose": that constraint is about which calls became a
// job (decided by replying to the WhatsApp digest, never by the portal).
// Binding the number that will SEND that digest is a one-time setup step
// with no such second-writer risk, and one the operator walks the client
// through live (see STATUS_COPY's contract_signed copy) rather than a
// button the client is expected to find and click alone.
//
// UNVERIFIED AGAINST A REAL META APP — same standing caveat as
// meta-business.ts and recall-meta.ts.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  not_configured: 'La conexión con WhatsApp no está disponible ahora mismo. Contacta con soporte.',
  subscription_not_found: 'No se encontró tu suscripción. Contacta con soporte.',
  invalid_status: 'Este paso ya no aplica a tu suscripción — recarga la página.',
  code_exchange_failed: 'No se pudo completar la conexión con Meta. Intenta de nuevo en un momento.',
  short_lived_token:
    'Meta nos dio un acceso que caduca enseguida, así que no hemos guardado la conexión. Avisa a soporte: hay que revisar la configuración de la app en Meta antes de volver a intentarlo.',
  phone_number_not_found: 'No se encontró ningún número en esa cuenta de WhatsApp Business.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

export interface RecallMetaConnectedSummary {
  displayPhoneNumber: string | null;
  /** 'active' | 'needs_reconnect' | 'revoked'. Solo 'active' cuenta como
   *  conectado: una conexión cuyo acceso Meta invalidó sigue existiendo en
   *  la base, pero no envía nada (ver markConnectionNeedsReconnect). */
  status: string;
}

export function RecallMetaConnectCard({
  metaAppId,
  signupConfigId,
  connected,
}: {
  metaAppId: string | null;
  /** Ver recallSignupConfigId (meta-signup-extras.ts). */
  signupConfigId: string | null;
  connected: RecallMetaConnectedSummary | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured from Meta's WA_EMBEDDED_SIGNUP postMessage event while the
  // popup is open. Unlike the standard FINISH event, coexistence's
  // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING carries only waba_id — the
  // server resolves the phone number id itself (see recall-meta.ts).
  const wabaId = useRef<string | null>(null);

  const configured = Boolean(metaAppId && signupConfigId);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://www.facebook.com') return;
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const payload = data as { type?: string; event?: string; data?: { waba_id?: string } };
      if (
        payload.type === 'WA_EMBEDDED_SIGNUP' &&
        payload.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' &&
        payload.data?.waba_id
      ) {
        wabaId.current = payload.data.waba_id;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  async function connect() {
    if (!metaAppId || !signupConfigId) return;
    setError(null);
    setBusy(true);
    wabaId.current = null;
    try {
      await loadFacebookSdk(metaAppId);
      window.FB?.login(
        (response: FBLoginResponse) => {
          void (async () => {
            try {
              const code = response.authResponse?.code;
              const waba = wabaId.current;
              if (!code || !waba) {
                setError('No se pudo completar la conexión — se cerró la ventana antes de terminar.');
                return;
              }
              const res = await fetch('/api/portal/recall/meta-connect', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code, wabaId: waba }),
              });
              if (!res.ok) {
                const detail = await res.json().catch(() => null);
                setError(ERROR_LABEL[detail?.error] ?? 'No se pudo conectar con WhatsApp.');
                return;
              }
              router.refresh();
            } catch (err) {
              setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
            } finally {
              setBusy(false);
            }
          })();
        },
        {
          config_id: signupConfigId,
          response_type: 'code',
          override_default_response_type: true,
          // featureType es lo que abre el flujo de Coexistence — ver
          // recallSignupConfigId en meta-signup-extras.ts.
          extras: COEXISTENCE_SIGNUP_EXTRAS,
        },
      );
    } catch (err) {
      setError(describeSdkLoadError(err));
      setBusy(false);
    }
  }

  if (connected && connected.status === 'active') {
    return (
      <div className="card space-y-2" data-testid="recall-meta-connect-card" data-connected="true">
        <h3 className="text-sm font-semibold">WhatsApp conectado</h3>
        <p className="text-sm text-kairikos-muted">
          {connected.displayPhoneNumber ?? 'Tu número ya está conectado.'} — sigues usando la app de WhatsApp
          Business en tu móvil exactamente igual que antes, no ha cambiado nada ahí.
        </p>
      </div>
    );
  }

  const lost = connected !== null;

  return (
    <div
      className={`card space-y-3 ${lost ? 'border-kairikos-danger/50' : ''}`}
      data-testid="recall-meta-connect-card"
      data-connected="false"
      data-reconnect={lost ? 'true' : 'false'}
    >
      <div>
        <h3 className="text-sm font-semibold">{lost ? 'Tu WhatsApp se ha desconectado' : 'Conectar tu WhatsApp'}</h3>
        <p className="mt-1 text-sm text-kairikos-muted">
          {lost ? (
            <>
              Meta ha dejado de aceptar el acceso
              {connected?.displayPhoneNumber ? ` de ${connected.displayPhoneNumber}` : ''}.{' '}
              <strong className="text-kairikos-danger">
                Hasta que vuelvas a conectarlo no sale ningún mensaje: ni a quien llama ni a ti.
              </strong>{' '}
              Necesitas el móvil con la app de WhatsApp Business de ese número; no pierdes nada de lo que tienes en
              ella.
            </>
          ) : (
            <>
              Te guiamos por teléfono mientras lo haces. Sigues usando la app de WhatsApp Business en tu móvil
              exactamente igual que ahora — esto no te la quita.
            </>
          )}
        </p>
      </div>
      {!configured ? (
        <p className="text-sm text-kairikos-muted" data-testid="recall-meta-not-configured">
          Todavía no disponible. Contacta con soporte.
        </p>
      ) : (
        <>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="recall-meta-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            onClick={connect}
            disabled={busy}
            data-testid="recall-meta-connect-button"
          >
            {busy ? 'Conectando…' : lost ? 'Volver a conectar WhatsApp' : 'Conectar WhatsApp'}
          </button>
        </>
      )}
    </div>
  );
}
