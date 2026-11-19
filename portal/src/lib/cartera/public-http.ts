import 'server-only';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';

// =============================================================================
// Cartera — límites de las rutas públicas, como lib/villas/public-http.ts.
//
// Por token y no por IP: el feed lo pide el runner de GitHub, cuya IP cambia
// en cada build. Un build pide el feed una o dos veces; el límite solo frena
// un bucle o un token filtrado que alguien martillea.
//
// El formulario de contacto (PR 5) tendrá aquí su propio límite, más estricto,
// y el CORS abierto que necesita: lo llama el navegador del comprador.
// =============================================================================

const feedLimiter = new InMemoryRateLimiter(60 * 1000);
export const FEED_READS_PER_MINUTE = 30;

export function allowFeedRead(token: string): boolean {
  return feedLimiter.check(`cartera-feed:${token}`, FEED_READS_PER_MINUTE);
}
