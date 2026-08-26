import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// WP-XX — shared status-transition rules for Lead ("Captación con IA").
// Route handlers stay thin; this is where "is this transition allowed"
// lives so it can't drift between the internal ingestion route and the
// client-facing PATCH route. Mirrors src/lib/web-quotes.ts's shape.
//
// 'server-only' — client components must NOT import this file. They
// replicate the same string comparisons inline instead, same split
// WebQuoteEditor.tsx already uses for web-quotes.ts's predicates.
// =============================================================================

/** nuevo -> contactado */
export function canMarkContacted(status: string): boolean {
  return status === 'nuevo';
}

/** contactado -> convertido */
export function canMarkConverted(status: string): boolean {
  return status === 'contactado';
}

/** Side-exit, reachable from nuevo or contactado — mirrors WebQuote's 'cancelled'. */
export function canDiscard(status: string): boolean {
  return status === 'nuevo' || status === 'contactado';
}

// --- Client-facing list: sort/filter --------------------------------------
// Leads Fase 8 — the client's own /portal/leads was a flat, newest-first
// list with no way to sort by priority or filter down to one status.
// Fine while a client has a handful of leads; once volume grows, a
// high-score lead from last week is buried under a wall of low-score
// ones from this morning — exactly the "which ones matter" question the
// product's whole pitch is built on answering.

export const LEAD_STATUS_FILTERS = ['nuevo', 'contactado', 'convertido', 'descartado'] as const;
export type LeadStatusFilter = (typeof LEAD_STATUS_FILTERS)[number];

/** Validates a status filter from the query string. `null` means "todos"
 *  — the default, and the only fallback for anything unrecognised, so a
 *  malformed or hostile value never breaks the page, it just shows
 *  everything. Same clamp-don't-crash posture as recall-client-view.ts's
 *  clampMonth/clampPage. */
export function parseLeadStatusFilter(raw: string | string[] | undefined): LeadStatusFilter | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && (LEAD_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as LeadStatusFilter)
    : null;
}

export const LEAD_SORT_OPTIONS = ['recientes', 'prioridad'] as const;
export type LeadSortOption = (typeof LEAD_SORT_OPTIONS)[number];

/** 'recientes' (newest first) is the only sensible default for anything
 *  not recognised — same reasoning as the status filter above. */
export function parseLeadSort(raw: string | string[] | undefined): LeadSortOption {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'prioridad' ? 'prioridad' : 'recientes';
}

// --- Stuck detection -----------------------------------------------------
// Leads Fase 5 deliberately shipped this queue as read-only support
// visibility per-client only, on the reasoning that "the client's own
// sales team owns the whole status lifecycle" (see LeadsSummaryPanel.tsx).
// True, but it left a gap that recall.ts and web-quotes.ts both close for
// their own products: nothing told an OPERATOR when a client's team had
// simply stopped working their leads. From the system's point of view a
// lead sitting in 'nuevo' for three weeks is indistinguishable from one
// contacted a minute ago — it looks fine because nothing is technically
// broken. Same shape as recall.ts's stuck detection, on purpose.
const STUCK_AFTER_DAYS: Readonly<Partial<Record<string, number>>> = {
  // Waiting on the client's team to make first contact. Tighter than any
  // of recall's client-blocked thresholds — a lead goes cold in days, not
  // weeks, and the whole product's pitch is "we prioritise so you don't
  // waste the good ones by acting too late".
  nuevo: 2,
  // Waiting on the client's team to close it out (convertido or
  // descartado). More rope than 'nuevo' — a real sales cycle takes time —
  // but still finite. A lead 'contactado' for a month with no resolution
  // is a stalled deal nobody is tracking, not a healthy one.
  contactado: 14,
};

/** Days after which a lead sitting in `status` should be surfaced to an
 *  operator. Null for the terminal statuses (`convertido`, `descartado`)
 *  — those are resting states, not stuck ones. */
export function stuckThresholdDays(status: string): number | null {
  return STUCK_AFTER_DAYS[status] ?? null;
}

/** Whether a lead that entered `status` at `since` is overdue as of `now`.
 *  Pure — same reasoning as recall.ts's isStuck: the queue computes this
 *  at render time so there is no date arithmetic in the query and the
 *  thresholds stay in one testable place. */
export function isStuck(status: string, since: Date, now: Date = new Date()): boolean {
  const threshold = stuckThresholdDays(status);
  if (threshold === null) return false;
  const elapsedDays = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays >= threshold;
}

// --- Operator queue ------------------------------------------------------

export interface LeadQueueRow {
  leadId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  status: string;
  /** When this lead entered its CURRENT status — the clock the stuck
   *  badge reads. `createdAt` while `nuevo` (that IS when it entered);
   *  `contactedAt` once `contactado` (its own transition timestamp, not
   *  `updatedAt`, which any unrelated edit would reset and hide a lead
   *  that has actually been stalled for weeks). */
  since: Date;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  score: number | null;
  channel: string | null;
}

function enteredCurrentStateAt(row: { status: string; createdAt: Date; contactedAt: Date | null }): Date {
  if (row.status === 'contactado' && row.contactedAt) return row.contactedAt;
  return row.createdAt;
}

/**
 * Every lead still open (`nuevo` or `contactado`) across every client, for
 * the operator's inbox. ONE query — same shape as listRecallQueue and
 * listWebQuoteQueue, not a query-per-client loop.
 *
 * Deliberately still doesn't let the operator MUTATE a lead's status from
 * here — that stays the client's sales team's call, per the design this
 * queue is layered on top of (LeadsSummaryPanel.tsx). This is triage
 * visibility only: which clients have gone quiet on their own leads.
 */
export async function listLeadsQueue(prisma: PrismaClient): Promise<LeadQueueRow[]> {
  const rows = await prisma.lead.findMany({
    where: { status: { in: ['nuevo', 'contactado'] } },
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      clientId: true,
      status: true,
      createdAt: true,
      contactedAt: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      score: true,
      channel: true,
      client: { select: { name: true, companyName: true, email: true } },
    },
  });

  return rows.map((row) => ({
    leadId: row.id,
    clientId: row.clientId,
    clientName: row.client.companyName ?? row.client.name,
    clientEmail: row.client.email,
    status: row.status,
    since: enteredCurrentStateAt(row),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    score: row.score,
    channel: row.channel,
  }));
}
