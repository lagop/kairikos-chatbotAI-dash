// =============================================================================
// Client-side loader for Meta's WhatsApp Embedded Signup SDK
// (connect.facebook.net/en_US/sdk.js — the plain <script> Meta ships,
// exposing a global `window.FB`; there is no first-party npm package).
//
// Extracted from MetaChannelCard.tsx (the original, chatbot-tier connect
// flow) so RecallMetaConnectCard.tsx (Fase 8's coexistence connect flow)
// does not carry a second copy of the same loader and the same
// `Window.FB` global type. Both flows open the identical popup mechanism
// against a DIFFERENT config_id — see meta-business.ts's header for why
// that is the one thing that actually differs between them.
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

export function loadFacebookSdk(appId: string): Promise<void> {
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
