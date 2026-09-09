import 'server-only';

// =============================================================================
// SEO con IA, Fase 5 — self-serve WordPress Application Password.
//
// "Da de alta WordPress: las credenciales las mete hoy un operador
// porque el cliente medio no sabe generar una contraseña de aplicación.
// WordPress tiene una pantalla de autorización pensada justo para eso,
// que devuelve la credencial al sitio que la pidió."
//
// El flujo (estable desde WordPress 5.6, ver el "Application Passwords
// Integration Guide" de make.wordpress.org/core, 2020-11-05):
//
//   1. Se redirige al navegador del CLIENTE a
//      {siteUrl}/wp-admin/authorize-application.php con app_name,
//      app_id, success_url y reject_url en la query.
//   2. El cliente entra con SU PROPIO login de wp-admin — el mismo con
//      el que ya administra su web — y pulsa Aprobar.
//   3. WordPress redirige el navegador a `success_url` añadiendo
//      site_url, user_login y password (la Application Password recién
//      creada) como query params.
//
// No es OAuth: WordPress no genera ni valida ningún `state` propio. El
// que exista uno aquí (WP_CONNECT_STATE_COOKIE) es cosa nuestra —
// viajando en la propia `success_url`, que WordPress reenvía intacta— y
// cumple el mismo papel que el de google-search-console.ts: sin él, una
// petición CSRF a la ruta de callback con site_url/user_login/password
// de un WordPress CUALQUIERA reemplazaría en silencio el destino donde
// se publica el contenido futuro de un cliente. `app_id` es una
// constante fija, no una por conexión: así una segunda autorización
// ACTUALIZA la aplicación existente en WordPress en vez de acumular
// entradas sueltas en la lista de "Application Passwords" del cliente.
//
// LA CREDENCIAL LLEGA POR QUERY STRING, no por un POST — así es como
// WordPress hace la redirección, y no hay forma de cambiarlo desde nuestro
// lado. Eso significa que, brevemente, viaja en la barra de direcciones
// del cliente y puede quedar en el historial de su navegador o en los
// logs de acceso de ESTE servidor (nunca en los de WordPress, que solo
// hace el redirect). Se mitiga lo que se puede mitigar: la ruta de
// callback nunca registra la query cruda, cifra la contraseña antes de
// escribir nada, y redirige de inmediato a una URL limpia para que no se
// quede en pantalla. Sigue siendo, con todo, mejor que el statu quo: hoy
// esa misma contraseña se la dicta el cliente al operador por el canal
// que tengan a mano —email, WhatsApp—, sin ningún cifrado de por medio.
//
// UNVERIFIED AGAINST A REAL WORDPRESS SITE — misma reserva que
// wordpress-publish.ts: nadie ha probado este flujo contra un WordPress
// real en este entorno.
// =============================================================================

/** Fijo a propósito — ver el porqué arriba. Un UUID cualquiera generado
 *  una vez para Kairikos, no uno por conexión. */
export const WORDPRESS_CONNECT_APP_ID = '3f1b9c3e-6b3a-4e6a-8a7e-3a2f6c1e9d21';

export const WORDPRESS_CONNECT_APP_NAME = 'Kairikos — Publicación SEO';

export const WORDPRESS_CONNECT_STATE_COOKIE = 'seo_wp_connect_state';

/**
 * Construye la URL de autorización. `null` si `siteUrl` no es una URL
 * http(s) válida — no hay forma de calcular una wp-admin/... de otra
 * cosa.
 */
export function buildAuthorizeApplicationUrl(
  siteUrl: string,
  opts: { successUrl: string; rejectUrl: string },
): string | null {
  let base: URL;
  try {
    base = new URL(siteUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;

  const authorizeUrl = new URL('/wp-admin/authorize-application.php', base);
  authorizeUrl.searchParams.set('app_name', WORDPRESS_CONNECT_APP_NAME);
  authorizeUrl.searchParams.set('app_id', WORDPRESS_CONNECT_APP_ID);
  authorizeUrl.searchParams.set('success_url', opts.successUrl);
  authorizeUrl.searchParams.set('reject_url', opts.rejectUrl);
  return authorizeUrl.toString();
}

export type ParsedAuthorizeCallback =
  | { ok: true; siteUrl: string; username: string; password: string }
  | { ok: false; error: 'missing_params' };

/**
 * Lee lo que WordPress añadió a `success_url`. Pura — no toca la base de
 * datos ni cifra nada; eso es responsabilidad de la ruta, que decide qué
 * hacer con el resultado.
 */
export function parseAuthorizeCallback(searchParams: URLSearchParams): ParsedAuthorizeCallback {
  const siteUrl = searchParams.get('site_url')?.trim();
  const username = searchParams.get('user_login')?.trim();
  const password = searchParams.get('password')?.trim();
  if (!siteUrl || !username || !password) {
    return { ok: false, error: 'missing_params' };
  }
  return { ok: true, siteUrl, username, password };
}
