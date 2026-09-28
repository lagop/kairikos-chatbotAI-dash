import 'server-only';

// =============================================================================
// De dónde sale la dirección pública del portal cuando hay que escribirla
// dentro de algo: un enlace que se manda por WhatsApp, el destino de un
// formulario que va a vivir en el servidor de otro.
//
// NO vale `new URL(req.url).origin`. Detrás del proxy, la petición que ve
// Next viene de la red interna de Docker, así que ese origin es
// `https://0.0.0.0:3000` y el enlace que se genera no lleva a ninguna parte.
//
// Encontrado en producción el 24/09/2026, generando el primer borrador desde
// el formulario público: la respuesta devolvió
// `https://0.0.0.0:3000/mi-web/<testigo>`. Es EXACTAMENTE el mismo fallo que
// ya mordió con el widget del chatbot apuntando a 0.0.0.0:3000 (ver
// CLAUDE.md), y por el mismo motivo: en local funciona.
//
// Orden: la variable pública primero, que es la única que sabe el dominio de
// verdad; si no está, las cabeceras del proxy; y como último recurso el
// origin de la petición, que al menos sirve en desarrollo.
// =============================================================================

export function publicOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_PORTAL_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host && !host.startsWith('0.0.0.0') && !host.startsWith('127.0.0.1')) {
    return `${proto}://${host}`;
  }

  return new URL(req.url).origin;
}
