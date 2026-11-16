// =============================================================================
// Reserva propia para villas — fechas de estancia.
//
// Una noche es un DÍA del calendario de la villa ('2026-12-14'), no un
// instante: se trabaja con cadenas ISO de fecha y aritmética en UTC, sin zona
// horaria. Así una solicitud hecha desde Nueva York a las 23:00 no se corre
// de día, y lo que llega de Postgres (columnas DATE, que Prisma devuelve como
// Date a medianoche UTC) se convierte sin sorpresas.
//
// Rangos [entrada, salida): la noche de salida no se ocupa, así que una salida
// y una entrada el mismo día no se solapan.
//
// Sin 'server-only': lo usan las rutas, el panel y los tests.
// =============================================================================

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ¿Es 'AAAA-MM-DD' y existe ese día? (rechaza 2026-02-30). */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Medianoche UTC de esa fecha: lo que Prisma espera en una columna @db.Date. */
export function toDbDate(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Lo contrario: de la Date que devuelve Prisma (o de cualquier instante) a su día UTC. */
export function fromDbDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDbDate(new Date(toDbDate(iso).getTime() + days * DAY_MS));
}

/** Noches entre llegada y salida (negativo si van al revés). */
export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number {
  return Math.round((toDbDate(checkOut).getTime() - toDbDate(checkIn).getTime()) / DAY_MS);
}

/** Cada noche ocupada: de la llegada a la víspera de la salida. */
export function eachNight(checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  const nights: IsoDate[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) nights.push(d);
  return nights;
}

/** ¿Se pisan dos rangos [a, b) y [c, d)? Comparación de cadenas ISO, que ordenan bien. */
export function rangesOverlap(aStart: IsoDate, aEnd: IsoDate, bStart: IsoDate, bEnd: IsoDate): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** El día de hoy en una zona horaria concreta (la de la villa). Por defecto,
 *  la de Canarias: es la de casi todos los clientes, y un día de diferencia
 *  con la península solo importa a medianoche. */
export function todayIn(timeZone = 'Atlantic/Canary', now: Date = new Date()): IsoDate {
  // en-CA formatea como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Primer día del mes de una fecha ('2026-12-14' → '2026-12-01'). */
export function startOfMonth(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 7)}-01`;
}

/** Mismo día del mes siguiente, o el primero (para recorrer meses). */
export function addMonths(monthStart: IsoDate, months: number): IsoDate {
  const d = toDbDate(monthStart);
  return fromDbDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)));
}
