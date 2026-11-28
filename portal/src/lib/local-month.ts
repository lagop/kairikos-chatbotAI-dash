import { localDateFor } from './recall-digest';

// =============================================================================
// Meses de calendario en la zona del cliente ('YYYY-MM'), sin base de datos.
//
// Nacieron en recall-reports.ts (informe mensual de llamadas) y se sacaron
// aquí el 28/11/2026 al llegar el segundo informe mensual, el de la web
// (web-results-report.ts): importarlos de recall-reports arrastraba WhatsApp,
// telefonía y Prisma hasta la página del panel. recall-reports los reexporta,
// así que sus importadores no cambian.
// =============================================================================

/** 'YYYY-MM' in the subscription's own timezone. */
export function localMonthFor(at: Date, timezone: string): string {
  return localDateFor(at, timezone).slice(0, 7);
}

/**
 * Move a 'YYYY-MM' key by whole months.
 *
 * String arithmetic rather than Date arithmetic on purpose: a month key
 * is a calendar label, and building a Date from it just to add a month
 * would drag a timezone into a question that has none.
 */
export function shiftLocalMonth(localMonth: string, delta: number): string {
  const [year, month] = localMonth.split('-').map(Number);
  // Months as a zero-based running count, so the year rolls over on its
  // own in both directions.
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** The month before the one `at` falls in, in the same timezone. */
export function previousLocalMonth(at: Date, timezone: string): string {
  return shiftLocalMonth(localMonthFor(at, timezone), -1);
}

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** 'julio' rather than '2026-07'. The report is read on a phone by
 *  someone who is not looking at a dashboard. */
export function monthLabel(localMonth: string): string {
  const [, month] = localMonth.split('-').map(Number);
  return MONTH_NAMES[month - 1] ?? localMonth;
}
