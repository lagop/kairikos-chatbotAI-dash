// =============================================================================
// Revisión de seguridad del 22/09/2026 — alta de autoservicio sin verificar.
//
// POST /api/public/self-serve-signup dejaba la cuenta lista para entrar y
// pagar en el acto, con la contraseña que eligiera quien rellenaba el
// formulario. Cualquiera podía registrar el correo de otro negocio
// (info@fontaneria-lopez.es) y quedarse con esa cuenta a su nombre.
//
// Ahora la contraseña del alta se guarda en User.passwordHash con este
// prefijo, y el login la rechaza hasta que alguien pulsa el enlace que llega
// a ese buzón (verifyEmailToken quita el prefijo). Es el mismo recurso que
// ya usa la columna para '__must_reset__': un valor que marca "esta cuenta
// todavía no puede entrar", sin migración y sin tocar ninguna cuenta que ya
// exista — solo las altas de autoservicio nacen con el prefijo.
//
// Sin 'server-only' a propósito: lo importa auth.ts.
// =============================================================================

export const PENDING_SIGNUP_PREFIX = 'pending:';

export function isPendingSignupHash(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === 'string' && passwordHash.startsWith(PENDING_SIGNUP_PREFIX);
}
