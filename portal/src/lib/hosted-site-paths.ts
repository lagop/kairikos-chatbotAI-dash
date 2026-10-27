// =============================================================================
// Webs con IA (27/10/2026) — servir bien las webs alojadas en /sitios/<slug>.
//
// Dos huecos que existían ya con la web de una página y que con varias
// páginas dejarían de ser teóricos (no hay todavía ninguna web publicada, así
// que no han afectado a nadie):
//
// 1. La web enlaza sus archivos con rutas RELATIVAS (assets/portada.jpg), que
//    es lo correcto para el servidor del cliente y para un dominio propio:
//    allí la web vive en la raíz. Pero la dirección provisional es
//    /sitios/<slug> SIN barra final —Next.js la quita—, y desde ahí
//    «assets/portada.jpg» se resuelve a /sitios/assets/portada.jpg: la foto
//    no carga. No se puede exigir la barra (Next redirige a la versión sin
//    ella), así que al servir el HTML por la dirección provisional se
//    reescriben las rutas relativas a absolutas.
// 2. Una página interior se pide como /sitios/<slug>/servicios y su archivo
//    es servicios/index.html.
// =============================================================================

/** El archivo que corresponde a una ruta pedida: '' → index.html; una ruta
 *  sin extensión es una página → <ruta>/index.html. */
export function resolveRequestedFile(segments: string[] | undefined): string {
  const joined = (segments ?? []).filter(Boolean).join('/');
  if (!joined) return 'index.html';
  const last = joined.split('/').pop() as string;
  return last.includes('.') ? joined : `${joined}/index.html`;
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * Reescribe los src="" y href="" relativos de una página para que funcionen
 * servida bajo `baseDir` ('/sitios/suarez/' o '/sitios/suarez/servicios/').
 * Deja en paz los absolutos, los de otro esquema (tel:, mailto:, https:) y
 * los anclas (#contacto), que son del propio documento.
 */
export function rewriteRelativeUrls(html: string, baseDir: string): string {
  const base = new URL(baseDir.endsWith('/') ? baseDir : `${baseDir}/`, 'https://sitio.invalid');
  return html.replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi, (match, attr: string, quote: string, value: string) => {
    if (!value || ABSOLUTE.test(value)) return match;
    const resolved = new URL(value, base);
    // Sin barra final en las páginas: Next.js la quita con una redirección
    // 308, y así se ahorra el salto (y la petición que, desde algunos
    // navegadores integrados, no completa esa redirección).
    const pathname = resolved.pathname.length > 1 ? resolved.pathname.replace(/\/$/, '') : resolved.pathname;
    return `${attr}${quote}${pathname}${resolved.search}${resolved.hash}${quote}`;
  });
}

/** ¿Se está pidiendo por la dirección provisional del portal? Con un dominio
 *  propio la web vive en la raíz y las rutas relativas ya funcionan. */
export function isPortalHost(host: string | null, portalUrl: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().split(':')[0];
  if (h === 'localhost' || h === '127.0.0.1') return true;
  try {
    return portalUrl ? new URL(portalUrl).hostname.toLowerCase() === h : false;
  } catch {
    return false;
  }
}
