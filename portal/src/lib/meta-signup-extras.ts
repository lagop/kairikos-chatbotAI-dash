// =============================================================================
// Cómo se abre el alta de WhatsApp de recall (Coexistence) en el popup de
// Meta. Puro y sin 'server-only': lo usan la página (servidor) y
// RecallMetaConnectCard (navegador).
//
// CORRECCIÓN 2026-09-16 — meta-business.ts daba por hecho que Coexistence se
// elige con una Configuration APARTE (META_COEXISTENCE_CONFIG_ID). No es así:
// se usa la misma configuración de Embedded Signup, y lo que abre el flujo de
// "conectar tu app de WhatsApp Business" es `extras.featureType =
// 'whatsapp_business_app_onboarding'` en FB.login. El único cliente de
// producción recibía "Función no disponible" de Meta con un
// coexistenceConfigId que no correspondía a ninguna configuración real.
//
// Fuente: developers.facebook.com/documentation/business-messaging/whatsapp/
// embedded-signup/onboarding-business-app-users (Meta pide además ser Tech
// Provider o Solution Partner, y app de WhatsApp Business ≥ 2.24.17).
// =============================================================================

/**
 * `extras` de FB.login para el alta de recall. Sin featureType, Meta nunca
 * enseña la pantalla de "conectar tu cuenta de WhatsApp Business existente"
 * y el alta registraría el número en la Cloud API, sacándolo de la app del
 * móvil — justo lo que Coexistence evita.
 */
export const COEXISTENCE_SIGNUP_EXTRAS = {
  setup: {},
  featureType: 'whatsapp_business_app_onboarding',
} as const;

/**
 * El config_id con el que se abre el alta de recall. coexistenceConfigId es
 * una anulación opcional; si no está, se usa la configuración del chatbot.
 */
export function recallSignupConfigId(
  creds: { configId: string | null; coexistenceConfigId: string | null } | null | undefined,
): string | null {
  return creds?.coexistenceConfigId?.trim() || creds?.configId?.trim() || null;
}
