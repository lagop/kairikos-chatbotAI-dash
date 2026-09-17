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
  return new Promise((resolve) => {
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, xfbml: false, version });
      initialisedVersion = version;
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
