// =============================================================================
// WP-XX (Fase 9) — unit tests for business hours.
//
// This module decides which promise a stranger gets told, so the tests
// are written around the ways it could quietly tell the wrong one: a
// timezone applied to the wrong clock, a Sunday read as a Monday, an
// interval that crosses midnight silently read as "never open", and a
// malformed column silently read as "closed forever".
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUSINESS_HOURS,
  parseBusinessHours,
  isWithinBusinessHours,
  describeNextOpening,
  type BusinessHours,
} from '@/lib/recall-hours';

const MADRID = 'Europe/Madrid';

/** Madrid wall-clock helper. July is CEST (UTC+2). */
const july = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 6, day, hour - 2, minute));

/** January is CET (UTC+1) — the same wall clock, a different offset. */
const january = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 0, day, hour - 1, minute));

// 2026-07-06 is a Monday, so 6..12 covers Mon..Sun.
const MONDAY = 6;
const SATURDAY = 11;
const SUNDAY = 12;

describe('parseBusinessHours', () => {
  it('falls back to the default when the column is empty', () => {
    expect(parseBusinessHours(null)).toBe(DEFAULT_BUSINESS_HOURS);
    expect(parseBusinessHours(undefined)).toBe(DEFAULT_BUSINESS_HOURS);
    expect(parseBusinessHours({})).toBe(DEFAULT_BUSINESS_HOURS);
    // A JSON array is valid JSON and completely wrong shape.
    expect(parseBusinessHours([['09:00', '14:00']])).toBe(DEFAULT_BUSINESS_HOURS);
  });

  it('keeps an explicit empty day rather than treating it as "unconfigured"', () => {
    // "cerramos los domingos" is a real answer and must survive. If this
    // fell back to the default the client would be told they are open.
    const parsed = parseBusinessHours({ mon: [['09:00', '18:00']], sun: [] });
    expect(parsed.mon).toEqual([['09:00', '18:00']]);
    expect(parsed.sun).toEqual([]);
    expect(parsed).not.toBe(DEFAULT_BUSINESS_HOURS);
  });

  it('drops garbage intervals without dropping the good ones beside them', () => {
    const parsed = parseBusinessHours({
      mon: [
        ['09:00', '14:00'],
        ['25:00', '26:00'],
        ['nueve', 'dos'],
        ['16:00'],
        ['16:00', '16:00'],
        ['16:00', '19:00'],
      ],
    });
    expect(parsed.mon).toEqual([
      ['09:00', '14:00'],
      ['16:00', '19:00'],
    ]);
  });

  it('never throws on hostile input — this runs inside a sweep', () => {
    for (const value of [42, 'nueve a dos', true, { mon: 'todo el día' }, { mon: [null, 7] }]) {
      expect(() => parseBusinessHours(value)).not.toThrow();
    }
  });
});

describe('isWithinBusinessHours', () => {
  it('reads the clock in the business timezone, not the server one', () => {
    // 08:30 UTC is 10:30 in Madrid (open) and 08:30 in London (open too),
    // so pick an hour where the two genuinely disagree: 19:30 Madrid is
    // 18:30 London — closed in Madrid, open in London.
    const at = july(MONDAY, 19, 30);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, at, MADRID)).toBe(false);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, at, 'Europe/London')).toBe(true);
  });

  it('stays correct across the DST change, because it never does date arithmetic', () => {
    // Same wall-clock Monday morning in summer and winter; one is UTC+2,
    // the other UTC+1. Both must read as open.
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 9), MADRID)).toBe(true);
    // 2026-01-05 is also a Monday.
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, january(5, 9), MADRID)).toBe(true);
  });

  it('closes for the Spanish lunch gap', () => {
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 13, 59), MADRID)).toBe(true);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 15), MADRID)).toBe(false);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 16), MADRID)).toBe(true);
  });

  it('treats the interval as half-open, so the closing minute is closed', () => {
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 8), MADRID)).toBe(true);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 7, 59), MADRID)).toBe(false);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 14), MADRID)).toBe(false);
  });

  it('gets Saturday and Sunday right — the two days most likely to be off by one', () => {
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(SATURDAY, 10), MADRID)).toBe(true);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(SATURDAY, 18), MADRID)).toBe(false);
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(SUNDAY, 10), MADRID)).toBe(false);
  });

  it('honours an interval that crosses midnight, on both sides of it', () => {
    // A locksmith or a late bar. Reading '22:00'-'02:00' as end<=start and
    // therefore "never" would tell this client's callers the wrong thing
    // every single night.
    const nightShift: BusinessHours = {
      ...DEFAULT_BUSINESS_HOURS,
      fri: [['22:00', '02:00']],
      sat: [],
    };
    // Friday 2026-07-10 at 23:00 — inside the leading half.
    expect(isWithinBusinessHours(nightShift, july(10, 23), MADRID)).toBe(true);
    // Saturday 01:00 — the tail that started yesterday.
    expect(isWithinBusinessHours(nightShift, july(SATURDAY, 1), MADRID)).toBe(true);
    // Saturday 03:00 — past the end.
    expect(isWithinBusinessHours(nightShift, july(SATURDAY, 3), MADRID)).toBe(false);
  });

  it('is closed all week when every day is empty', () => {
    const never: BusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(isWithinBusinessHours(never, july(MONDAY, 11), MADRID)).toBe(false);
  });

  it('falls back to UTC instead of throwing on an unknown timezone', () => {
    // A bad timezone string must degrade, not take the sweep down.
    expect(() => isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, july(MONDAY, 11), 'Mars/Olympus')).not.toThrow();
  });
});

describe('describeNextOpening', () => {
  it('says "hoy" for a later slot the same day', () => {
    expect(describeNextOpening(DEFAULT_BUSINESS_HOURS, july(MONDAY, 15), MADRID)).toBe('hoy a las 16:00');
  });

  it('says "mañana" once today is over', () => {
    expect(describeNextOpening(DEFAULT_BUSINESS_HOURS, july(MONDAY, 21), MADRID)).toBe('mañana a las 8:00');
  });

  it('names the weekday when it is further out, in Spanish', () => {
    // Saturday evening: the next opening is Monday.
    expect(describeNextOpening(DEFAULT_BUSINESS_HOURS, july(SATURDAY, 20), MADRID)).toBe('el lunes a las 8:00');
  });

  it('rolls over the end of the week rather than running out of days', () => {
    expect(describeNextOpening(DEFAULT_BUSINESS_HOURS, july(SUNDAY, 12), MADRID)).toBe('mañana a las 8:00');
  });

  it('returns null when nothing opens all week, so the caller can pick vaguer wording', () => {
    const never: BusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(describeNextOpening(never, july(MONDAY, 11), MADRID)).toBeNull();
  });

  it('picks the earliest remaining slot, not the first one listed', () => {
    const unsorted: BusinessHours = {
      ...DEFAULT_BUSINESS_HOURS,
      mon: [['16:00', '19:00'], ['08:00', '14:00']],
    };
    expect(describeNextOpening(unsorted, july(MONDAY, 6), MADRID)).toBe('hoy a las 8:00');
  });
});
