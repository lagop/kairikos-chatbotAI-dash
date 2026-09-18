import 'server-only';

// =============================================================================
// Fase 2 multi-instancia — llevar la contratación a través del viaje por
// Google, sin perder la protección CSRF.
//
// Los dos flujos OAuth de SEO (Search Console y GA4) salen del portal, pasan
// por Google y vuelven a un callback. Hasta ahora eso bastaba: al volver, la
// conexión se guardaba contra el cliente de la sesión, y había una por
// cliente. Con varias webs por cliente, el callback tiene que saber A CUÁL de
// ellas pertenece la autorización que acaba de terminar.
//
// La forma obvia sería mandar el clientProductId en el parámetro `state` que
// viaja a Google. No se hace: ese parámetro va en la URL, queda en los
// registros de Google y en el historial del navegador. Aquí viaja solo un
// nonce aleatorio, y el clientProductId se guarda junto a él en la MISMA
// cookie httpOnly que ya se usaba para la comprobación CSRF.
//
// Así la propiedad de seguridad no cambia — sigue siendo un double-submit
// cookie: el `state` que vuelve de Google tiene que coincidir con el nonce
// que hay en la cookie— y de paso el clientProductId es inalterable desde el
// navegador, que es justo lo que hace falta: quien vuelve del OAuth no puede
// redirigir la conexión a la contratación de otro.
//
// Aun así el callback NO se fía de él: lo vuelve a resolver contra la sesión
// con resolveContractedInstance, porque una cookie es del navegador y la
// autorización es del servidor.
// =============================================================================

const SEPARATOR = ':';

/** Lo que se guarda en la cookie httpOnly. El nonce es lo único que viaja. */
export function encodeOAuthState(nonce: string, clientProductId: string): string {
  return `${nonce}${SEPARATOR}${clientProductId}`;
}

export interface DecodedOAuthState {
  nonce: string;
  clientProductId: string | null;
}

/**
 * Lee la cookie. Devuelve `clientProductId: null` para las cookies del
 * formato antiguo (solo el nonce), que pueden estar en vuelo mientras se
 * despliega esto: un OAuth empezado antes del despliegue y terminado después.
 * El llamante trata ese caso como "resuelve la única contratación que haya",
 * que es exactamente lo que hacía antes.
 */
export function decodeOAuthState(raw: string | null | undefined): DecodedOAuthState | null {
  if (!raw) return null;
  const index = raw.indexOf(SEPARATOR);
  if (index === -1) return { nonce: raw, clientProductId: null };
  const nonce = raw.slice(0, index);
  const clientProductId = raw.slice(index + 1);
  if (!nonce) return null;
  return { nonce, clientProductId: clientProductId || null };
}
