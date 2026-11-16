import { randomBytes, randomInt } from 'node:crypto';

// =============================================================================
// Reserva propia para villas — el ciclo de una solicitud.
//
//   pending ──aceptar──▶ accepted ──pago──▶ confirmed ──cancelar──▶ cancelled
//      │                    │  └──cancelar──▶ cancelled
//      ├─rechazar─▶ declined └──sin pago en plazo──▶ expired
//      └─sin respuesta en plazo─▶ expired
//
// Las transiciones viven aquí y no en cada ruta (regla del repo: las columnas
// de estado son texto libre y la validación es de aplicación). requests.ts las
// aplica con updateMany condicionado al estado de origen, así dos clics a la
// vez —o el cron y el dueño— no pueden pasar la misma solicitud dos veces.
// =============================================================================

export const REQUEST_STATUSES = ['pending', 'accepted', 'confirmed', 'declined', 'expired', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ['accepted', 'declined', 'expired'],
  accepted: ['confirmed', 'expired', 'cancelled'],
  confirmed: ['cancelled'],
  declined: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: string, to: RequestStatus): boolean {
  return (REQUEST_STATUSES as readonly string[]).includes(from) && TRANSITIONS[from as RequestStatus].includes(to);
}

/** Motivos de un rechazo. 'dates_taken' lo pone el sistema al confirmarse
 *  otra solicitud que se solapa; los demás, el dueño. */
export const DECLINE_REASONS = ['unavailable', 'dates_taken', 'other'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Límites de los plazos que puede poner el dueño. Menos de 2 h no da tiempo a
 *  mirar los calendarios; más de 72 h deja al huésped colgado. El pago, entre
 *  12 h y 7 días. */
export const CONFIRM_HOURS_RANGE = { min: 2, max: 72 } as const;
export const PAYMENT_HOURS_RANGE = { min: 12, max: 168 } as const;
export const DEPOSIT_PERCENT_RANGE = { min: 10, max: 100 } as const;

const HOUR_MS = 60 * 60 * 1000;

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

/** ¿Esta solicitud ocupa sus noches ahora mismo? */
export function isBlocking(request: { status: string; paymentDueAt: Date | null }, now: Date = new Date()): boolean {
  if (request.status === 'confirmed') return true;
  if (request.status === 'accepted') return request.paymentDueAt !== null && request.paymentDueAt > now;
  return false;
}

/** Stripe deja una sesión de Checkout abierta entre 30 min y 24 h. La sesión
 *  nunca vive más que el plazo de pago, así no se puede pagar una solicitud ya
 *  caducada. Si quedan menos de 30 min, se usa el mínimo y el plazo se alarga
 *  hasta ahí (lo dice la función con `extendDueTo`). */
export function checkoutExpiry(paymentDueAt: Date, now: Date = new Date()): { expiresAt: Date; extendDueTo: Date | null } {
  const min = new Date(now.getTime() + 31 * 60 * 1000);
  const max = new Date(now.getTime() + 23.5 * HOUR_MS);
  if (paymentDueAt < min) return { expiresAt: min, extendDueTo: min };
  return { expiresAt: paymentDueAt < max ? paymentDueAt : max, extendDueTo: null };
}

// Sin 0/O ni 1/I/L: la referencia se dicta por teléfono.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** «VR-7K3Q9P». Seis caracteres de 31: ~887 millones; la columna es única y
 *  quien la crea reintenta si choca. */
export function generateReference(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `VR-${out}`;
}

/** Token de la página del huésped: 192 bits, en URL. */
export function generateGuestToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Token público del widget (vil_…) e iCal de salida: 144 bits. */
export function generatePublicToken(prefix: 'vil' | 'ical'): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

/** 'Villa Alcornoque' → 'villa-alcornoque'. Para el ?unidad= de la web. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'villa'
  );
}
