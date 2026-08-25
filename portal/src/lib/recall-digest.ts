import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// WP-XX (Fase 10) — the 19:00 digest and the owner's reply to it.
//
// At the end of the day the owner gets one message listing the calls we
// recovered, numbered. He answers "1 y 3" and those two callers get a
// review request.
//
// WHY THE OWNER PICKS, AND WHAT HE IS PICKING
//
// He is answering "which of these turned into an actual job", NOT "which
// of these were happy". The first is necessary — you may only ask for a
// review from someone you actually served, and only he knows who that
// was. The second is review gating, which violates Google's policy and is
// the thing the Spanish market leader in this space openly advertises.
//
// The distinction is preserved structurally, not by discipline: nothing
// in RecallDigest or ReviewRequest can hold a sentiment, a rating, or a
// satisfaction score, so there is nothing for a future well-meaning
// change to start branching on.
//
// Everything about the day boundary is WALL-CLOCK, in the subscription's
// own timezone. "The owner's Tuesday" is not an interval of UTC, and
// treating it as one would move his digest by an hour twice a year.
// =============================================================================

/** How long after the digest hour we still consider it worth sending. A
 *  tick missed at 19:00 should deliver at 19:05; one missed until 23:00
 *  should be dropped, because a "day's summary" arriving at midnight is
 *  noise the owner learns to ignore. */
export const DIGEST_LATE_CUTOFF_HOURS = 3;

/** How long after sending we still treat an inbound message as a reply to
 *  the digest rather than as ordinary conversation. */
export const DIGEST_REPLY_WINDOW_HOURS = 20;

/** Give up sending after this many failures, same reasoning as the
 *  messaging engine's budget. */
export const MAX_DIGEST_ATTEMPTS = 3;

export const DIGEST_TEMPLATES = {
  /** {{1}} how many calls, {{2}} the numbered list. */
  daily: { name: 'recall_daily_digest', languageCode: 'es' },
  /** {{1}} the numbered list. Sent at most once, when a reply made no
   *  sense at all. */
  clarify: { name: 'recall_digest_clarify', languageCode: 'es' },
} as const;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(at: Date, timezone: string): ZonedParts {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

  let parts;
  try {
    parts = format(timezone);
  } catch {
    // An unknown IANA zone must degrade, never take a sweep down.
    parts = format('UTC');
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // '24' appears at midnight in some ICU builds under hour12:false.
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/** 'YYYY-MM-DD' in the subscription's own timezone — the digest's
 *  identity, and the half of its unique key that makes the job idempotent
 *  across a tick that runs every five minutes. */
export function localDateFor(at: Date, timezone: string): string {
  const { year, month, day } = zonedParts(at, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Local wall-clock minutes since midnight. */
export function localMinutesFor(at: Date, timezone: string): number {
  const { hour, minute } = zonedParts(at, timezone);
  return hour * 60 + minute;
}

/**
 * Is it time to send today's digest?
 *
 * Deliberately a predicate over `now` rather than a schedule: the tick is
 * coarse and may be missed entirely, so this re-answers the question each
 * time (the isDigestDue pattern from conversation-digest.ts). The late
 * cutoff is what stops a scheduler that was down all evening from
 * delivering yesterday's summary at two in the morning.
 */
export function isDigestDue(
  subscription: { digestHour: number; timezone: string },
  now: Date,
): boolean {
  const minutes = localMinutesFor(now, subscription.timezone);
  const start = subscription.digestHour * 60;
  return minutes >= start && minutes < start + DIGEST_LATE_CUTOFF_HOURS * 60;
}

/** The UTC instant that begins the given local day, near enough for a
 *  day-window query. Computed as an offset from `now` rather than by
 *  reconstructing an absolute local date, same approach and same caveat
 *  as conversation-digest.ts: correct across offsets, not DST-exact to
 *  the minute, which a once-a-day summary does not need. */
export function startOfLocalDay(now: Date, timezone: string): Date {
  return new Date(now.getTime() - localMinutesFor(now, timezone) * 60 * 1000);
}

export interface DigestCall {
  id: string;
  fromNumber: string | null;
  withheld: boolean;
  transcript: string | null;
  outcome: string;
}

/** How much of a transcript survives into one digest line. Short on
 *  purpose: the digest is a picker, not a reader — the full text is
 *  already in the message he got at the time of the call. */
const LINE_SUMMARY_MAX = 60;

function shortenForLine(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= LINE_SUMMARY_MAX) return clean;
  const cut = clean.slice(0, LINE_SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > LINE_SUMMARY_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The numbered list the owner sees.
 *
 * Separated by ' · ' and NOT by newlines. Meta rejects the entire send
 * with "Param text cannot have new-line/tab characters or more than 4
 * consecutive spaces" — a hard 400 that isRetryableWhatsAppError
 * correctly never retries, so a newline here means the digest is silently
 * never delivered. sanitiseTemplateParam is the backstop; this is the
 * design that does not need it.
 */
export function buildDigestList(calls: readonly DigestCall[]): string {
  return calls
    .map((call, index) => {
      const who = call.withheld || !call.fromNumber ? 'número oculto' : call.fromNumber;
      const what = call.transcript ? shortenForLine(call.transcript) : 'sin recado';
      return `${index + 1}) ${who} – ${what}`;
    })
    .join(' · ');
}

// ---------------------------------------------------------------------------
// The reply parser
// ---------------------------------------------------------------------------

export type DigestReply =
  | { kind: 'selection'; indices: number[] }
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'unclear' };

// Matched against single words AFTER accents are stripped, so every
// entry here is unaccented and space-free — an accented or multi-word
// entry would be dead weight that reads like coverage.
const ALL_WORDS = ['todos', 'todas', 'todo', 'all', 'tots'];
const NONE_WORDS = ['ninguno', 'ninguna', 'ningun', 'nadie', 'nada', 'no', 'cero', 'none'];

/**
 * Read whatever the owner actually typed.
 *
 * Forgiving on purpose. This is a man with wet hands on a building site
 * answering a WhatsApp, not a form: "1 y 3", "el 1 y el 3", "1,3", "1-3",
 * "todos", "ninguno", "0". Being strict here does not teach him the
 * syntax, it just loses the answer — and a lost answer means real
 * customers never get asked for the review the client is paying for.
 *
 * Out-of-range numbers are DROPPED rather than failing the whole reply:
 * "1 y 7" with three calls plainly means the first one. Only a reply with
 * no usable number at all comes back 'unclear'.
 */
export function parseDigestReply(raw: string, count: number): DigestReply {
  const text = raw
    .toLowerCase()
    .normalize('NFD')
    // Strip accents so 'ningún' and 'ningun' are the same word.
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (!text) return { kind: 'unclear' };

  const words = text.split(/[^a-z0-9]+/).filter(Boolean);

  // A bare '0' is the documented way to say "none", so it is checked
  // before digits are read as selections.
  if (words.length > 0 && words.every((w) => w === '0')) return { kind: 'none' };
  if (words.some((w) => NONE_WORDS.includes(w))) return { kind: 'none' };
  if (words.some((w) => ALL_WORDS.includes(w))) return { kind: 'all' };

  const seen = new Set<number>();
  for (const match of text.matchAll(/\d+/g)) {
    const value = Number(match[0]);
    if (Number.isInteger(value) && value >= 1 && value <= count) seen.add(value);
  }

  if (seen.size === 0) return { kind: 'unclear' };
  return { kind: 'selection', indices: [...seen].sort((a, b) => a - b) };
}

/** Resolve a parsed reply against the digest's own ordering. The order is
 *  read from the stored array, never recomputed — a query returning a
 *  different order later would silently remap what the owner chose. */
export function resolveSelection(reply: DigestReply, callEventIds: readonly string[]): string[] {
  if (reply.kind === 'all') return [...callEventIds];
  if (reply.kind === 'selection') return reply.indices.map((i) => callEventIds[i - 1]).filter(Boolean);
  return [];
}

/** Read the JSON column back as an ordered id list, tolerating anything
 *  that is not one rather than throwing inside a sweep. */
export function callIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// Which calls belong in today's digest
// ---------------------------------------------------------------------------

/**
 * The calls worth listing: today's, with a real number to ask, that we
 * actually recovered.
 *
 * A withheld caller is excluded — there is nobody to send a review
 * request to, so offering him as a choice would only produce a selection
 * we cannot act on.
 */
export async function listDigestCalls(
  prisma: PrismaClient,
  subscriptionId: string,
  since: Date,
  until: Date,
): Promise<DigestCall[]> {
  return prisma.callEvent.findMany({
    where: {
      subscriptionId,
      startedAt: { gte: since, lt: until },
      withheld: false,
      fromNumber: { not: null },
      outcome: { in: ['recorded', 'no_message'] },
    },
    orderBy: { startedAt: 'asc' },
    select: { id: true, fromNumber: true, withheld: true, transcript: true, outcome: true },
  });
}
