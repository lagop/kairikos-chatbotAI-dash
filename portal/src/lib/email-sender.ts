import 'server-only';

// =============================================================================
// De quién salen los correos del portal.
//
// Los ocho módulos de email resolvían esto por su cuenta con la misma
// cadena `OPERATOR_NOTIFY_FROM ?? AUTH_EMAIL_FROM ?? <literal>`. El `??`
// es la trampa: solo salta a la siguiente opción cuando la variable NO
// EXISTE, y docker-compose declara todas las del bloque `environment:`
// aunque el `.env` de la VPS las tenga vacías. Es decir, en producción
// `OPERATOR_NOTIFY_FROM` existía valiendo cadena vacía, ganaba el `??`, y
// cada envío salía con remitente en blanco. Resend lo rechaza con un
// mensaje que despista del todo: "The domain is invalid" — parece un
// problema de DNS del dominio y no lo es.
//
// Visto el 22/09/2026, enviando de verdad desde producción: el mismo
// correo, con `contacto@kairikos.com` escrito a mano, salió sin problema.
//
// La regla, ahora en un solo sitio: una variable vacía o con solo espacios
// es lo mismo que no tenerla.
// =============================================================================

function firstConfigured(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** El remitente de los avisos del portal (resúmenes, leads, presupuestos,
 *  reseñas, derivaciones…). `AUTH_EMAIL_FROM` es el respaldo porque es la
 *  que siempre ha estado puesta: es la que usan los correos de acceso, los
 *  únicos que llegaban. */
export function notifyFromAddress(): string {
  return (
    firstConfigured(process.env.OPERATOR_NOTIFY_FROM, process.env.AUTH_EMAIL_FROM)
    ?? 'Kairikos Ops <ops@kairikos.com>'
  );
}

/** El remitente de los correos de la cuenta (verificación, contraseña). */
export function authFromAddress(): string {
  return firstConfigured(process.env.AUTH_EMAIL_FROM) ?? 'Kairikos Portal <hola@kairikos.com>';
}
