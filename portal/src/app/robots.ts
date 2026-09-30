import type { MetadataRoute } from 'next';
import { portalBaseUrl } from '@/lib/portal-base-url';

// =============================================================================
// robots.txt del portal (30/09/2026). Hasta hoy devolvía 404 con la página de
// error en HTML, y Google no tenía por dónde empezar.
//
// Lo privado ya lleva noindex (el layout raíz lo pone en todo y solo lo
// levantan las páginas públicas que lo piden). Aquí además se le dice al
// rastreador que no gaste visitas en la API, el panel y el portal de cliente.
//
// NO se cierra /sitios/: ahí viven las webs que alojamos a los clientes, y esas
// tienen que indexarse. Su HTML no pasa por el layout de Next (es una ruta que
// devuelve el archivo tal cual), así que no heredan el noindex.
// =============================================================================

export default function robots(): MetadataRoute.Robots {
  const base = portalBaseUrl();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/admin/', '/portal/'] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
