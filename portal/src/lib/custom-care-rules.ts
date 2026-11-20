// =============================================================================
// Mantenimiento a medida — las reglas puras, sin base de datos ni Stripe, para
// que las compartan el servidor (lib/custom-care.ts) y las pantallas.
// =============================================================================

export const WEB_CARE_PRODUCT_CODE = 'web_care';

/** Tope de meses sin cobrar: 24. Stripe no acepta un periodo de prueba de
 *  más de 730 días, y la suscripción no llegaría a crearse. */
export const MAX_TRIAL_MONTHS = 24;

/**
 * La cuota que escribe el operador, en céntimos. Vacía, 0 o negativa =
 * sin mantenimiento (null): no existe una cuota de 0 €.
 */
export function normalizeMonthlyCents(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const cents = Math.round(value);
  return cents > 0 ? cents : null;
}

/**
 * Cuándo se cobra la primera cuota si el cliente la activa en `from`.
 * Suma meses de calendario; si el día no existe en el mes de destino (31 de
 * enero + 1 mes), se queda en el último día de ese mes, como hace Stripe.
 */
export function firstChargeDate(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Lo que dice el presupuesto cuando no lleva cuota (Orlando, 11/11/2026). */
export const NO_MAINTENANCE_TEXT =
  'Sin mantenimiento. Pasados los 12 meses de alojamiento incluidos, te entregamos la web para que la alojes donde elijas.';

/**
 * La línea de mantenimiento de un presupuesto, tal cual la lee el cliente (en
 * el portal y en el correo). Sin cuota lo dice: callarlo daría a entender que
 * el mantenimiento va incluido para siempre.
 */
export function maintenanceLine(monthlyCents: number | null, startsAfterMonths: number, currency: string): string {
  if (!monthlyCents) return NO_MAINTENANCE_TEXT;
  const price = new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(monthlyCents / 100);
  if (startsAfterMonths <= 0) return `Mantenimiento: ${price}/mes desde el primer mes.`;
  if (startsAfterMonths === 1) return `Mantenimiento: ${price}/mes. El primer mes va incluido; la cuota empieza a cobrarse después.`;
  return `Mantenimiento: ${price}/mes. Los ${startsAfterMonths} primeros meses van incluidos; la cuota empieza a cobrarse después.`;
}

/**
 * Los niveles de mantenimiento de una web (decisión del propietario,
 * 20/11/2026). Rellenan la cuota y los meses sin cobrar del formulario; el
 * operador puede cambiarlos antes de guardar. Una web Premium se vende con
 * 12 meses de Cuidado Premium incluidos.
 */
export const CARE_TIERS = [
  { key: 'care', label: 'Cuidado', monthlyCents: 2900, includedMonths: 0, hint: 'Web sencilla: hosting, seguridad y copias.' },
  {
    key: 'premium',
    label: 'Cuidado Premium',
    monthlyCents: 12900,
    includedMonths: 12,
    hint: 'Web Premium: hasta 2 h de cambios al mes, chat y normativa al día.',
  },
  {
    key: 'premium_modules',
    label: 'Premium con módulos',
    monthlyCents: 17900,
    includedMonths: 12,
    hint: 'Web Premium con cartera o reserva de villas.',
  },
] as const;
