import 'server-only';

// =============================================================================
// Las claves de cifrado que lee el portal, en un solo sitio.
//
// Cada clase de secreto tiene su propia clave (CLAUDE.md, «Datos y
// persistencia»), y cada clave vive SOLO en el entorno, nunca en Postgres:
// una clave guardada junto al texto cifrado que abre no protege nada frente a
// quien tenga acceso a la base de datos.
//
// Esta lista la usan dos cosas:
//   - el panel de solo lectura de /admin/portal/settings/security, para que
//     el operador vea qué falta sin entrar por SSH;
//   - deploy-env-wiring.test.ts, que comprueba que es EXACTAMENTE la lista de
//     claves que lee el código, y que cada una está en .env.example,
//     docker-compose.yml y deploy.yml.
//
// La primera versión del panel (PR #150, 01/09/2026) tenía la lista escrita
// a mano dentro del componente, y en cuatro semanas se quedó sin dos claves
// (ANTHROPIC_… y WEBSITE_PUBLISH_…). Al revisarla apareció algo peor:
// GOOGLE_SEO_TOKEN_ENCRYPTION_KEY y GOOGLE_GA4_TOKEN_ENCRYPTION_KEY nunca
// estuvieron en deploy.yml, así que en producción llegaban vacías y Search
// Console y GA4 no podían conectarse (la trampa 2 de CLAUDE.md, otra vez).
// Por eso la lista ya no es algo que haya que acordarse de actualizar: si el
// código lee una clave que no está aquí, el test falla.
// =============================================================================

export interface ClaveDeCifrado {
  nombre: string;
  protege: string;
}

export const CLAVES_DE_CIFRADO: readonly ClaveDeCifrado[] = Object.freeze([
  { nombre: 'OPERATOR_TOTP_ENCRYPTION_KEY', protege: 'Secretos de la verificación en dos pasos de los operadores' },
  { nombre: 'CHANNEL_CREDENTIAL_ENCRYPTION_KEY', protege: 'Tokens de Telegram y Meta de cada cliente, una vez conectados' },
  { nombre: 'META_CREDENTIAL_ENCRYPTION_KEY', protege: 'App Secret de Meta (reseñas, llamadas perdidas, canales)' },
  { nombre: 'TWILIO_CREDENTIAL_ENCRYPTION_KEY', protege: 'Auth Token de Twilio (llamadas perdidas)' },
  { nombre: 'STRIPE_CREDENTIAL_ENCRYPTION_KEY', protege: 'Clave secreta de Stripe (facturación)' },
  { nombre: 'ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY', protege: 'Clave de la API de Anthropic (todas las funciones de IA)' },
  { nombre: 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', protege: 'Google Places y los clientes OAuth de Integraciones' },
  { nombre: 'GOOGLE_TOKEN_ENCRYPTION_KEY', protege: 'Token de refresco de Google Business Profile (reseñas)' },
  { nombre: 'GOOGLE_SEO_TOKEN_ENCRYPTION_KEY', protege: 'Token de refresco de Search Console (SEO)' },
  { nombre: 'GOOGLE_GA4_TOKEN_ENCRYPTION_KEY', protege: 'Token de refresco de Google Analytics 4 (SEO)' },
  { nombre: 'SEO_CMS_CREDENTIAL_ENCRYPTION_KEY', protege: 'Application Password de WordPress (SEO)' },
  { nombre: 'WEBSITE_PUBLISH_CREDENTIAL_ENCRYPTION_KEY', protege: 'Contraseña SFTP del alojamiento de cada web' },
]);

export type EstadoDeClave = 'configurada' | 'falta' | 'formato_invalido';

/**
 * Lo mismo que exige parseHexKey (operator-crypto.ts) al usarla: 32 bytes en
 * hexadecimal, 64 caracteres. Se comprueba aquí porque una clave mal pegada
 * no falla al arrancar sino al primer cifrado o descifrado, lejos de donde se
 * puso. Vacía cuenta como ausente: docker-compose.yml declara todas las
 * variables, así que una clave que no llega existe valiendo '' (trampa 4).
 */
export function estadoDeClave(valor: string | undefined): EstadoDeClave {
  if (!valor) return 'falta';
  return /^[0-9a-fA-F]{64}$/.test(valor) ? 'configurada' : 'formato_invalido';
}
