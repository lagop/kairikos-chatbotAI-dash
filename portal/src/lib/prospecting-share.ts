import 'server-only';
import { randomBytes } from 'node:crypto';

// =============================================================================
// A1 / A11 — enlaces públicos del informe comparativo y del borrador de web.
//
// Por qué existen: los dos se generan para ENSEÑÁRSELOS a un negocio que no
// es cliente. El comercial los abre en la llamada y los manda después por
// WhatsApp. El prospecto no tiene sesión de operador, ni cuenta, ni ganas de
// crearla: si el enlace pide identificarse, no sirve para nada.
//
// La primera versión de las dos rutas era solo de operador y fallaba justo
// en su único uso real. El arreglo NO es abrir las rutas de operador, es
// separar dos cosas que se habían mezclado:
//
//   GENERAR   cuesta dinero (Google, Anthropic) → sigue siendo del operador.
//   ENSEÑAR   solo lee lo ya guardado           → público con testigo.
//
// Así el enlace público no puede quemar tu cuenta por mucho que lo recarguen:
// si no hay nada generado, devuelve 404 en vez de generarlo.
//
// El testigo son 32 bytes aleatorios (64 caracteres hex). No es una
// contraseña: es una URL que no se puede adivinar, el mismo patrón que
// /r/[requestId] para las invitaciones a reseñar, que también van a gente sin
// cuenta. Lo que hay detrás es información pública de Google sobre un negocio
// más una propuesta comercial nuestra; no hay datos personales ni de otros
// clientes, así que el riesgo de que alguien reenvíe el enlace es el mismo
// que el de reenviar un correo comercial.
// =============================================================================

export function createShareToken(): string {
  return randomBytes(32).toString('hex');
}

/** Un testigo con forma válida. Se comprueba antes de ir a la base de datos:
 *  un rastreador que pruebe /borrador/loquesea no merece una consulta. */
export function isShareToken(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** La URL que se copia y se pega en WhatsApp. `origin` sale de la petición
 *  del operador, así que funciona igual en local y en producción sin una
 *  variable de entorno nueva — que además sería la quinta cosa que olvidar
 *  en deploy.yml. */
export function webDraftShareUrl(origin: string, token: string): string {
  return `${origin}/borrador/${token}`;
}

export function reportShareUrl(origin: string, token: string): string {
  return `${origin}/informe/${token}`;
}
