import 'server-only';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — verificar en Search Console una web
// que hacemos nosotros, sin que el cliente toque nada.
//
// Con WordPress, el callback de Search Console exige que la web YA esté
// verificada en la cuenta del cliente (connect_error=site_not_verified): no
// podemos escribir en su web. Con una web nuestra sí: pedimos a Google el
// código de la etiqueta <meta name="google-site-verification">, lo ponemos en
// la portada (SiteContent.verificacionGoogle), publicamos y le pedimos a
// Google que compruebe y añada la propiedad a Search Console.
//
// Eso necesita dos permisos más que el de solo lectura de siempre
// (siteverification y webmasters), y SOLO se piden cuando el perfil de SEO
// apunta a una web de Kairikos (oauth/start).
//
// LIMITACIÓN CONOCIDA: escrito contra la documentación de las APIs (Site
// Verification v1 y Search Console v3) y probado con respuestas simuladas;
// no ha hablado con Google de verdad porque el cliente OAuth real de Search
// Console sigue pendiente (memoria: SEO blocking prerequisites). La dirección
// provisional /sitios/<slug>/ redirige sin la barra final; si Google no sigue
// esa redirección al verificar, la verificación fallará hasta tener dominio.
// =============================================================================

export const SITE_VERIFICATION_SCOPE = 'https://www.googleapis.com/auth/siteverification';
export const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';
/** Lo que se pide de más cuando el SEO es sobre una web de Kairikos. */
export const KAIRIKOS_WEBSITE_SCOPES = [SITE_VERIFICATION_SCOPE, WEBMASTERS_SCOPE] as const;

const TOKEN_URL = 'https://www.googleapis.com/siteVerification/v1/token';
const WEB_RESOURCE_URL = 'https://www.googleapis.com/siteVerification/v1/webResource';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

export type VerificationStepResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | { ok: false; error: string };

/** El código de la etiqueta que devuelve Google
 *  ('<meta name="google-site-verification" content="abc" />' → 'abc'). */
export function parseMetaToken(token: string): string | null {
  const m = /content\s*=\s*["']([A-Za-z0-9_-]{10,100})["']/.exec(token);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,100}$/.test(token.trim()) ? token.trim() : null;
}

async function call(url: string, init: RequestInit, accessToken: string): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `google_${res.status}:${detail.slice(0, 200)}` };
    }
    const text = await res.text();
    return { ok: true, json: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'google_network_error' };
  }
}

/** Paso 1: el código de la etiqueta para esta dirección. */
export async function getMetaVerificationToken(accessToken: string, siteUrl: string): Promise<VerificationStepResult<string>> {
  const r = await call(
    TOKEN_URL,
    { method: 'POST', body: JSON.stringify({ verificationMethod: 'META', site: { type: 'SITE', identifier: siteUrl } }) },
    accessToken,
  );
  if (!r.ok) return r;
  const raw = (r.json as { token?: unknown } | null)?.token;
  const token = typeof raw === 'string' ? parseMetaToken(raw) : null;
  return token ? { ok: true, value: token } : { ok: false, error: 'google_token_unreadable' };
}

/** Paso 2 (con la etiqueta ya publicada): que Google la compruebe. */
export async function verifySiteOwnership(accessToken: string, siteUrl: string): Promise<VerificationStepResult> {
  const r = await call(
    `${WEB_RESOURCE_URL}?verificationMethod=META`,
    { method: 'POST', body: JSON.stringify({ site: { type: 'SITE', identifier: siteUrl } }) },
    accessToken,
  );
  return r.ok ? { ok: true } : r;
}

/** Paso 3: añadir la propiedad a su Search Console. */
export async function addSearchConsoleSite(accessToken: string, siteUrl: string): Promise<VerificationStepResult> {
  const r = await call(`${SITES_URL}/${encodeURIComponent(siteUrl)}`, { method: 'PUT' }, accessToken);
  return r.ok ? { ok: true } : r;
}
