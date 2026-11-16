// =============================================================================
// Reserva propia para villas — la baja del cliente (docs/plan-reserva-villas.md,
// «Baja del cliente»). Reglas puras, sin base de datos.
//
// La web Signature es del cliente; este módulo es un servicio del portal ligado
// a la suscripción. Al darse de baja, el dueño tiene un plazo de gracia para
// llevarse sus datos (RGPD art. 28.3.g: Kairikos es encargado y los devuelve al
// acabar) y para quitar nuestro iCal de Airbnb y Booking. Pasado el plazo, el
// cron borra la VillaRental entera.
//
// El plazo cuenta desde la baja, pero nunca acaba antes de EXIT_MIN_NOTICE_DAYS
// desde el aviso al dueño: si el aviso sale tarde (el cron estuvo parado, o la
// baja es anterior a este código), el dueño no se queda con dos días.
// =============================================================================

export const EXIT_GRACE_DAYS = 30;
export const EXIT_MIN_NOTICE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * - active:    funciona todo.
 * - suspended: la contratación existe pero no está activa y no es una baja
 *              (pausada, impago, pendiente de pago). No entra nada nuevo; no
 *              corre plazo ni se borra nada.
 * - grace:     dada de baja, dentro del plazo: solo exportar y el iCal congelado.
 * - closed:    dada de baja y fuera de plazo: se purga.
 */
export type ServiceState = 'active' | 'suspended' | 'grace' | 'closed';

export interface ContractForExit {
  status: string;
  cancelledAt: Date | null;
  changedAt: Date;
}

/** Cuándo acaba el plazo de gracia de una baja. Sin `cancelledAt` (filas
 *  antiguas o una baja hecha a mano) vale la fecha del último cambio de estado. */
export function graceEndsAt(contract: ContractForExit, exitNotifiedAt: Date | null): Date {
  const since = contract.cancelledAt ?? contract.changedAt;
  const byCancel = since.getTime() + EXIT_GRACE_DAYS * DAY_MS;
  const byNotice = exitNotifiedAt ? exitNotifiedAt.getTime() + EXIT_MIN_NOTICE_DAYS * DAY_MS : 0;
  return new Date(Math.max(byCancel, byNotice));
}

export function serviceState(
  contract: ContractForExit,
  exitNotifiedAt: Date | null,
  now: Date = new Date(),
): { state: ServiceState; graceEndsAt: Date | null } {
  if (contract.status === 'active') return { state: 'active', graceEndsAt: null };
  if (contract.status !== 'cancelled') return { state: 'suspended', graceEndsAt: null };
  const ends = graceEndsAt(contract, exitNotifiedAt);
  // Sin aviso todavía no se purga nunca: el cron avisa primero, y ese aviso
  // alarga el plazo si hace falta (graceEndsAt).
  if (!exitNotifiedAt || now < ends) return { state: 'grace', graceEndsAt: ends };
  return { state: 'closed', graceEndsAt: ends };
}

/** El plazo que se le anuncia al dueño en el aviso de baja, enviado en `now`. */
export function announcedGraceEnd(contract: ContractForExit, now: Date): Date {
  return graceEndsAt(contract, now);
}

/** La línea X-WR-CALDESC del iCal congelado: la leen el dueño y quien abra la
 *  URL a mano (Airbnb y Booking no la enseñan). */
export function frozenCalendarDescription(since: Date, state: 'suspended' | 'grace'): string {
  const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(since);
  return state === 'grace'
    ? `Calendario de Kairikos SIN ACTUALIZAR desde el ${day}: el servicio de reservas se ha dado de baja. Quita esta URL de Airbnb y Booking.`
    : `Calendario de Kairikos en pausa desde el ${day}: las fechas no se actualizan hasta que se reactive el servicio.`;
}
