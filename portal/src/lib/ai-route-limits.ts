import 'server-only';
import { InMemoryRateLimiter } from './operator-crypto';

// =============================================================================
// Revisión de seguridad del 22/09/2026 — límites en las rutas del portal que
// gastan en la API de Anthropic a petición del cliente.
//
// El widget público ya tenía el suyo; estas tres no: un script con la sesión
// de un cliente (o un bucle en su navegador) podía llamar al modelo miles de
// veces por hora, y la factura es nuestra — ningún plan incluye un tope por
// llamada en estas pantallas. Los números están muy por encima de un uso a
// mano: un asistente al que se le pregunta cada pocos segundos, una tanda de
// reseñas redactadas una tras otra.
//
// En memoria, por proceso, como el resto de limitadores del portal: el
// portal corre en un solo contenedor. Si algún día son varios, cada réplica
// deja pasar su propio cupo — sigue acotando el gasto, solo que por réplica.
// =============================================================================

const WINDOW_MS = 10 * 60 * 1000;

const LIMITS = {
  assistant: 40,
  review_reply_draft: 30,
  prospecting_suggest: 10,
} as const;

export type AiRouteScope = keyof typeof LIMITS;

const limiter = new InMemoryRateLimiter(WINDOW_MS);

/** true si el cliente aún tiene cupo en esta pantalla (y lo consume). */
export function takeAiRequest(scope: AiRouteScope, clientId: string): boolean {
  return limiter.check(`${scope}:${clientId}`, LIMITS[scope]);
}

export const AI_RATE_LIMITED_RESPONSE = {
  error: 'too_many_requests',
  detail: 'Demasiadas peticiones seguidas. Espera unos minutos y vuelve a intentarlo.',
} as const;
