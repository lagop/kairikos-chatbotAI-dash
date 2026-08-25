// =============================================================================
// WP-XX (Fase 9) — business hours for the 'recall' product.
//
// Why this matters enough to be its own module: the message a caller gets
// at 11:00 on a Tuesday and the one they get at 23:40 on a Saturday are
// different promises. "Te contestamos enseguida" sent at midnight is a
// lie the business then has to live with, and a caller who was told
// "enseguida" and hears nothing for nine hours is more annoyed than one
// who was never messaged at all.
//
// Deliberately NOT `server-only` and deliberately free of Prisma: every
// function here is pure, so the tests exercise the real logic rather than
// a mock of it. The only ambient dependency is Intl, which Node ships
// with full ICU.
// =============================================================================

/** 'HH:MM'–'HH:MM' in the subscription's own timezone. */
export type Interval = readonly [string, string];

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type BusinessHours = Readonly<Record<DayKey, readonly Interval[]>>;

const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Intl's `weekday: 'short'` in en-US, mapped to our keys. */
const WEEKDAY_TO_KEY: Readonly<Record<string, DayKey>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const DAY_LABEL: Readonly<Record<DayKey, string>> = {
  mon: 'lunes',
  tue: 'martes',
  wed: 'miércoles',
  thu: 'jueves',
  fri: 'viernes',
  sat: 'sábado',
  sun: 'domingo',
};

/**
 * What a Spanish trades business typically works, used when the client
 * never told us anything.
 *
 * A default is not a detail here: with no hours configured the engine has
 * to choose between messaging at 03:00 and not messaging at all, and both
 * are wrong. This makes the common case right without an onboarding step.
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: [['08:00', '14:00'], ['16:00', '19:00']],
  tue: [['08:00', '14:00'], ['16:00', '19:00']],
  wed: [['08:00', '14:00'], ['16:00', '19:00']],
  thu: [['08:00', '14:00'], ['16:00', '19:00']],
  fri: [['08:00', '14:00'], ['16:00', '19:00']],
  sat: [['09:00', '13:00']],
  sun: [],
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight, or null if it isn't a valid 'HH:MM'. */
function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Read whatever is in the `businessHours` JSON column.
 *
 * Tolerant on purpose. This column is written by an operator form and
 * read by a job that decides whether to message a stranger; a typo in one
 * day's hours must not throw and take the whole sweep with it. Anything
 * unrecognisable is dropped, and a value with no usable days at all falls
 * back to the default rather than to "closed forever" — silently never
 * messaging anyone is the worst failure this module can have, because
 * nothing about it looks broken.
 */
export function parseBusinessHours(value: unknown): BusinessHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_BUSINESS_HOURS;

  const source = value as Record<string, unknown>;
  const parsed: Record<DayKey, Interval[]> = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  let sawAnyDay = false;

  for (const day of DAY_KEYS) {
    const raw = source[day];
    if (raw === undefined) continue;
    // An explicit empty array is a real answer — "closed on Sundays" —
    // so it counts as a day we saw even though it adds no intervals.
    sawAnyDay = true;
    if (!Array.isArray(raw)) continue;

    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const start = toMinutes(entry[0]);
      const end = toMinutes(entry[1]);
      if (start === null || end === null) continue;
      // A zero-length interval is a data-entry slip, not "open for an
      // instant". Dropping it beats honouring it.
      if (start === end) continue;
      parsed[day].push([entry[0] as string, entry[1] as string]);
    }
  }

  return sawAnyDay ? (parsed as BusinessHours) : DEFAULT_BUSINESS_HOURS;
}

interface ZonedNow {
  day: DayKey;
  minutes: number;
}

function getZoned(at: Date, timezone: string): ZonedNow {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    // An unknown IANA zone must not take the sweep down. UTC is wrong by
    // at most a couple of hours for our market and the alternative is a
    // thrown error on every call for that client.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  }

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  // '24' appears at midnight in some ICU builds under hour12:false.
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { day: WEEKDAY_TO_KEY[weekday] ?? 'mon', minutes: hour * 60 + minute };
}

function previousDay(day: DayKey): DayKey {
  const i = DAY_KEYS.indexOf(day);
  return DAY_KEYS[(i + DAY_KEYS.length - 1) % DAY_KEYS.length];
}

function nextDay(day: DayKey): DayKey {
  const i = DAY_KEYS.indexOf(day);
  return DAY_KEYS[(i + 1) % DAY_KEYS.length];
}

/**
 * Is the business open at `at`, in its own timezone?
 *
 * Intervals whose end is at or before their start are treated as running
 * past midnight ('22:00'–'02:00'), which is why yesterday's intervals are
 * consulted too. A bar or a locksmith really does work those hours, and
 * silently reading such an interval as "never open" would produce a
 * client whose callers are told the wrong thing every single night.
 */
export function isWithinBusinessHours(hours: BusinessHours, at: Date, timezone: string): boolean {
  const { day, minutes } = getZoned(at, timezone);

  for (const [startRaw, endRaw] of hours[day] ?? []) {
    const start = toMinutes(startRaw);
    const end = toMinutes(endRaw);
    if (start === null || end === null) continue;
    if (end > start) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start) {
      // Wraps past midnight: open from `start` to the end of the day.
      return true;
    }
  }

  // The tail of an interval that started yesterday and crossed midnight.
  for (const [startRaw, endRaw] of hours[previousDay(day)] ?? []) {
    const start = toMinutes(startRaw);
    const end = toMinutes(endRaw);
    if (start === null || end === null) continue;
    if (end <= start && minutes < end) return true;
  }

  return false;
}

/**
 * Human phrasing of when the business opens next, for the out-of-hours
 * message: 'hoy a las 16:00', 'mañana a las 8:00', 'el lunes a las 8:00'.
 *
 * Returns null when nothing opens in the next week — a client with no
 * open hours at all. The caller must then fall back to wording that
 * promises no time, rather than printing 'null' at a stranger.
 */
export function describeNextOpening(hours: BusinessHours, at: Date, timezone: string): string | null {
  const { day, minutes } = getZoned(at, timezone);

  let cursor = day;
  for (let offset = 0; offset < 7; offset += 1) {
    const starts = (hours[cursor] ?? [])
      .map(([start]) => toMinutes(start))
      .filter((m): m is number => m !== null)
      .sort((a, b) => a - b);

    for (const start of starts) {
      if (offset > 0 || start > minutes) {
        const time = formatMinutes(start);
        if (offset === 0) return `hoy a las ${time}`;
        if (offset === 1) return `mañana a las ${time}`;
        return `el ${DAY_LABEL[cursor]} a las ${time}`;
      }
    }
    cursor = nextDay(cursor);
  }

  return null;
}
