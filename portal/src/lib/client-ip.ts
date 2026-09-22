// =============================================================================
// La IP del visitante, para los límites de intentos.
//
// Hasta el 22/09/2026 cada limitador leía la PRIMERA entrada de
// X-Forwarded-For. Esa entrada la escribe el propio cliente: Traefik (y el
// nginx del perfil alternativo) añaden la IP real AL FINAL de lo que llegó.
// Cambiándola en cada petición, el límite por IP no se alcanzaba nunca.
//
// Orden de confianza: X-Real-Ip, que el proxy pone con la IP que ve él; si no
// está, la ÚLTIMA entrada de X-Forwarded-For, que es la que añadió el proxy.
// Solo vale con la app detrás del proxy: si el puerto de la app se publica
// hacia fuera, cualquiera puede mandar estas cabeceras directamente (ver el
// bloque `ports` de docker-compose.yml).
// =============================================================================

export function clientIpFromHeaders(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return 'unknown';
}
