// =============================================================================
// Client-side loader for Meta's WhatsApp Embedded Signup SDK
// (connect.facebook.net/en_US/sdk.js — the plain <script> Meta ships,
// exposing a global `window.FB`; there is no first-party npm package).
//
// Extracted from MetaChannelCard.tsx (the original, chatbot-tier connect
// flow) so RecallMetaConnectCard.tsx (Fase 8's coexistence connect flow)
// does not carry a second copy of the same loader and the same
// `Window.FB` global type. Both flows open the identical popup mechanism
// with the same config_id; recall adds extras.featureType — see
// meta-signup-extras.ts (corrected 2026-09-16).
// =============================================================================

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

export interface FBLoginResponse {
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

/** La versión con la que se inicializa el SDK para los clientes. */
export const DEFAULT_SDK_VERSION = 'v21.0';

/** Versiones que ofrece la página de prueba de Admin → Meta. */
export const SDK_VERSIONS = ['v21.0', 'v22.0', 'v23.0', 'v24.0', 'v25.0', 'v26.0'] as const;

// Con qué versión se inicializó el SDK en esta página. FB.init se puede
// volver a llamar; hace falta para que la página de prueba cambie de
// versión sin recargar (2026-09-17: la ventana de alta se cerraba al
// instante con v21.0 y había que descartar la versión como causa).
let initialisedVersion: string | null = null;

export function loadFacebookSdk(appId: string, version: string = DEFAULT_SDK_VERSION): Promise<void> {
  if (window.FB) {
    if (initialisedVersion !== version) {
      window.FB.init({ appId, xfbml: false, version });
      initialisedVersion = version;
    }
    return Promise.resolve();
  }
  // 2026-09-17 — antes esta promesa no terminaba nunca si el script no
  // cargaba (un bloqueador de anuncios, una red que corta facebook.net): el
  // botón se quedaba en 'Conectando…' sin decir nada. Ahora falla con un
  // error que se puede enseñar.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SDK_LOAD_TIMEOUT)), SDK_LOAD_TIMEOUT_MS);
    window.fbAsyncInit = () => {
      clearTimeout(timer);
      window.FB?.init({ appId, xfbml: false, version });
      initialisedVersion = version;
      resolve();
    };
    const existing = document.getElementById('facebook-jssdk');
    if (existing) {
      // Un intento anterior ya añadió el script y no llegó a cargar: se
      // quita para que este intento lo pida de nuevo en vez de esperar a un
      // fbAsyncInit que no va a llegar.
      existing.remove();
    }
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error(SDK_LOAD_BLOCKED));
    };
    document.body.appendChild(script);
  });
}

export const SDK_LOAD_TIMEOUT = 'facebook_sdk_timeout';
export const SDK_LOAD_BLOCKED = 'facebook_sdk_blocked';
const SDK_LOAD_TIMEOUT_MS = 15_000;

/** Un fallo al cargar el SDK, en palabras que un cliente puede usar. */
export function describeSdkLoadError(err: unknown): string {
  const reason = err instanceof Error ? err.message : '';
  if (reason === SDK_LOAD_BLOCKED) {
    return 'Tu navegador no dejó cargar la ventana de Meta. Si usas un bloqueador de anuncios o una extensión de privacidad, desactívala para esta página y vuelve a intentarlo.';
  }
  if (reason === SDK_LOAD_TIMEOUT) {
    return 'La ventana de Meta tardó demasiado en cargar. Revisa tu conexión y vuelve a intentarlo.';
  }
  return `No se pudo cargar la ventana de Meta${reason ? `: ${reason}` : ''}.`;
}
