// =============================================================================
// WP-XX (Fase 10) — unit tests for the digest's pure half.
//
// Two things carry real risk here and both are silent when wrong:
//
//   The day boundary. "The owner's Tuesday" is wall-clock, so a UTC
//   shortcut looks correct for ten months and then moves his digest by an
//   hour twice a year — and puts late-evening calls on the wrong day.
//
//   The parser. Every phrasing it fails to read is a lost answer, and a
//   lost answer means real customers never get asked for the review the
//   client is paying for. So the tests are a list of things a man with wet
//   hands actually types.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  localDateFor,
  localMinutesFor,
  isDigestDue,
  startOfLocalDay,
  buildDigestList,
  parseDigestReply,
  resolveSelection,
  callIdsOf,
  DIGEST_LATE_CUTOFF_HOURS,
  type DigestCall,
} from '@/lib/recall-digest';

const MADRID = 'Europe/Madrid';

describe('localDateFor', () => {
  it('reports the local day, not the UTC one', () => {
    // 22:30 UTC on 6 July is already 00:30 on 7 July in Madrid. A call at
    // that moment belongs to the owner's Tuesday, not his Monday.
    const at = new Date('2026-07-06T22:30:00.000Z');
    expect(localDateFor(at, MADRID)).toBe('2026-07-07');
    expect(localDateFor(at, 'UTC')).toBe('2026-07-06');
  });

  it('handles both sides of the DST change without date arithmetic', () => {
    // Summer, UTC+2.
    expect(localDateFor(new Date('2026-07-06T23:30:00.000Z'), MADRID)).toBe('2026-07-07');
    // Winter, UTC+1 — the same UTC clock time is still the next day, but
    // only by half an hour, which is exactly where an off-by-one lives.
    expect(localDateFor(new Date('2026-01-05T23:30:00.000Z'), MADRID)).toBe('2026-01-06');
  });

  it('zero-pads, so the string sorts and compares as a date', () => {
    expect(localDateFor(new Date('2026-01-05T12:00:00.000Z'), MADRID)).toBe('2026-01-05');
  });

  it('falls back to UTC rather than throwing on a bad timezone', () => {
    expect(() => localDateFor(new Date(), 'Mars/Olympus')).not.toThrow();
  });
});

describe('localMinutesFor', () => {
  it('converts to wall-clock minutes in the target zone', () => {
    // 17:00 UTC is 19:00 in Madrid.
    expect(localMinutesFor(new Date('2026-07-07T17:00:00.000Z'), MADRID)).toBe(19 * 60);
  });

  it('reads midnight as 0, not 1440', () => {
    expect(localMinutesFor(new Date('2026-07-06T22:00:00.000Z'), MADRID)).toBe(0);
  });
});

describe('isDigestDue', () => {
  const sub = { digestHour: 19, timezone: MADRID };
  const madrid = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 6, 7, hour - 2, minute));

  it('is not due before the hour', () => {
    expect(isDigestDue(sub, madrid(18, 59))).toBe(false);
  });

  it('is due at the hour and through the catch-up window', () => {
    expect(isDigestDue(sub, madrid(19))).toBe(true);
    // A tick missed at 19:00 must still deliver at 19:05.
    expect(isDigestDue(sub, madrid(19, 5))).toBe(true);
    expect(isDigestDue(sub, madrid(19 + DIGEST_LATE_CUTOFF_HOURS - 1, 59))).toBe(true);
  });

  it('stops being due once the summary would arrive too late to read as one', () => {
    // A scheduler that was down all evening must not deliver the day's
    // summary at two in the morning.
    expect(isDigestDue(sub, madrid(19 + DIGEST_LATE_CUTOFF_HOURS))).toBe(false);
    expect(isDigestDue(sub, madrid(23, 30))).toBe(false);
  });

  it('honours a client who wants it at a different hour', () => {
    expect(isDigestDue({ digestHour: 14, timezone: MADRID }, madrid(14, 10))).toBe(true);
    expect(isDigestDue({ digestHour: 14, timezone: MADRID }, madrid(19))).toBe(false);
  });
});

describe('startOfLocalDay', () => {
  it('lands on the local midnight that precedes now', () => {
    const now = new Date('2026-07-07T17:00:00.000Z'); // 19:00 Madrid
    const start = startOfLocalDay(now, MADRID);
    expect(localMinutesFor(start, MADRID)).toBe(0);
    expect(localDateFor(start, MADRID)).toBe('2026-07-07');
    expect(start.getTime()).toBeLessThan(now.getTime());
  });
});

describe('buildDigestList', () => {
  const call = (over: Partial<DigestCall> = {}): DigestCall => ({
    id: 'c1',
    fromNumber: '+34651234567',
    withheld: false,
    transcript: 'Llamaba por una fuga en el baño',
    outcome: 'recorded',
    ...over,
  });

  it('numbers from 1, because that is what the owner replies with', () => {
    const list = buildDigestList([call({ id: 'a' }), call({ id: 'b', fromNumber: '+34620111222' })]);
    expect(list).toContain('1) +34651234567');
    expect(list).toContain('2) +34620111222');
  });

  it('NEVER emits a newline, a tab, or four consecutive spaces', () => {
    // Meta rejects the whole send with "Param text cannot have
    // new-line/tab characters or more than 4 consecutive spaces" — a hard
    // 400 that is never retried, so a newline here means the digest is
    // silently never delivered.
    const list = buildDigestList([
      call({ id: 'a', transcript: 'Hola,\nllamaba\tpor        una fuga' }),
      call({ id: 'b' }),
    ]);
    expect(list).not.toMatch(/[\r\n\t]/);
    expect(list).not.toMatch(/ {4,}/);
  });

  it('describes a call with no message rather than leaving a blank', () => {
    expect(buildDigestList([call({ transcript: null, outcome: 'no_message' })])).toContain('sin recado');
  });

  it('truncates a long transcript on a word boundary', () => {
    const long = 'palabra '.repeat(40);
    const list = buildDigestList([call({ transcript: long })]);
    expect(list).toContain('…');
    expect(list).not.toContain('palabr…');
  });

  it('produces an empty string for no calls, so a caller can test length', () => {
    expect(buildDigestList([])).toBe('');
  });
});

describe('parseDigestReply', () => {
  const parse = (text: string) => parseDigestReply(text, 3);

  it('reads the phrasings a person actually types', () => {
    for (const text of ['1 y 3', 'el 1 y el 3', '1,3', '1, 3', '1 3', '1-3', 'los numeros 1 y 3']) {
      expect(parse(text)).toEqual({ kind: 'selection', indices: [1, 3] });
    }
  });

  it('reads a single number', () => {
    expect(parse('2')).toEqual({ kind: 'selection', indices: [2] });
    expect(parse('el 2')).toEqual({ kind: 'selection', indices: [2] });
  });

  it('understands "all", accented or not', () => {
    for (const text of ['todos', 'Todos', 'todas', 'TODOS', 'todo']) {
      expect(parse(text)).toEqual({ kind: 'all' });
    }
  });

  it('understands "none", including the documented "0"', () => {
    for (const text of ['0', 'ninguno', 'ninguna', 'ningún', 'ningun', 'nadie', 'no', 'Ninguno.']) {
      expect(parse(text)).toEqual({ kind: 'none' });
    }
  });

  it('sorts and de-duplicates, so "3 y 1 y 3" is one coherent answer', () => {
    expect(parse('3 y 1 y 3')).toEqual({ kind: 'selection', indices: [1, 3] });
  });

  it('drops an out-of-range number instead of failing the whole reply', () => {
    // "1 y 7" with three calls plainly means the first one.
    expect(parse('1 y 7')).toEqual({ kind: 'selection', indices: [1] });
  });

  it('is unclear only when there is nothing usable at all', () => {
    for (const text of ['gracias', '👍', '', '   ', 'luego te digo', '7 y 9']) {
      expect(parse(text)).toEqual({ kind: 'unclear' });
    }
  });

  it('does not read "0" inside a real selection as "none"', () => {
    // '10' is out of range for three calls, so this is unclear — but the
    // point is that the zero inside it must not trigger the none branch.
    expect(parseDigestReply('10', 3)).toEqual({ kind: 'unclear' });
    expect(parseDigestReply('10', 12)).toEqual({ kind: 'selection', indices: [10] });
  });

  it('lets an explicit "no" win over a stray digit, because that is what it means', () => {
    expect(parse('no, ninguno de los 3')).toEqual({ kind: 'none' });
  });
});

describe('resolveSelection', () => {
  const ids = ['a', 'b', 'c'];

  it('maps the numbers the owner saw onto the ids the digest recorded', () => {
    expect(resolveSelection({ kind: 'selection', indices: [1, 3] }, ids)).toEqual(['a', 'c']);
  });

  it('expands "all" to the stored order', () => {
    expect(resolveSelection({ kind: 'all' }, ids)).toEqual(['a', 'b', 'c']);
  });

  it('yields nothing for none or unclear', () => {
    expect(resolveSelection({ kind: 'none' }, ids)).toEqual([]);
    expect(resolveSelection({ kind: 'unclear' }, ids)).toEqual([]);
  });

  it('drops an index with no id behind it rather than emitting undefined', () => {
    expect(resolveSelection({ kind: 'selection', indices: [1, 9] }, ids)).toEqual(['a']);
  });
});

describe('callIdsOf', () => {
  it('reads a stored array back', () => {
    expect(callIdsOf(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('tolerates anything else rather than throwing inside a sweep', () => {
    expect(callIdsOf(null)).toEqual([]);
    expect(callIdsOf({ a: 1 })).toEqual([]);
    expect(callIdsOf(['a', 7, null, 'b'])).toEqual(['a', 'b']);
  });
});
