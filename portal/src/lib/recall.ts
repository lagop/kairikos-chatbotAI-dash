import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// WP-XX — transition rules for the 'recall' product (missed-call recovery
// + review requests). Same shape as web-quotes.ts: pure predicates live
// here so the rules cannot drift between the routes that call them.
//
// The state machine is mostly linear because each step BINDS A RESOURCE
// that the next one needs — you cannot approve templates before there is
// a WhatsApp connection to create them on, and you cannot verify call
// forwarding before a number exists to forward to:
//
//   paid → contract_signed → meta_connected → number_assigned
//        → templates_approved → forwarding_pending → forwarding_verified
//        → active
//
// with `paused` and `cancelled` as side exits, and `paused → active` as
// the only way back in.
//
// Deliberately NOT modelled on the wizard engine (ChatbotConfigStep):
// most of these transitions are gated on someone else's system — Meta's
// review queue, Twilio provisioning, and the client dialling MMI codes on
// his own handset — which draft→submitted→approved cannot express.
// =============================================================================

export const RECALL_STATUSES = [
  'paid',
  'contract_signed',
  'meta_connected',
  'number_assigned',
  'templates_approved',
  'forwarding_pending',
  'forwarding_verified',
  'active',
  'paused',
  'cancelled',
] as const;

export type RecallStatus = (typeof RECALL_STATUSES)[number];

export function isRecallStatus(value: string): value is RecallStatus {
  return (RECALL_STATUSES as readonly string[]).includes(value);
}

/** The happy path, in order. `paused`/`cancelled` are deliberately absent —
 *  they are side exits, not steps, and are reached via their own predicates. */
const ONBOARDING_SEQUENCE: readonly RecallStatus[] = [
  'paid',
  'contract_signed',
  'meta_connected',
  'number_assigned',
  'templates_approved',
  'forwarding_pending',
  'forwarding_verified',
  'active',
];

/** Statuses from which the onboarding is still in progress — i.e. the
 *  client is paying but the service is NOT yet answering his calls. This
 *  is what the operator's stuck-detection queue filters on. */
export function isOnboarding(status: string): boolean {
  return ONBOARDING_SEQUENCE.includes(status as RecallStatus) && status !== 'active';
}

/** True once the service is actually answering calls. Note this is NOT the
 *  same question as "is he paying" — that is ClientProduct.status, which
 *  billing owns. A row can be `active` here and `past_due` there, or
 *  `forwarding_pending` here and `active` there (the normal state of a
 *  client who paid this morning and hasn't dialled the codes yet). */
export function isLive(status: string): boolean {
  return status === 'active';
}

/** The single legal forward step from a given status, or null when there
 *  isn't one (already active, or on a side exit). Every advancing route
 *  goes through this rather than hardcoding its own "next". */
export function nextOnboardingStatus(status: string): RecallStatus | null {
  const index = ONBOARDING_SEQUENCE.indexOf(status as RecallStatus);
  if (index === -1 || index === ONBOARDING_SEQUENCE.length - 1) return null;
  return ONBOARDING_SEQUENCE[index + 1];
}

export function canAdvanceTo(from: string, to: string): boolean {
  return nextOnboardingStatus(from) === to;
}

// --- Resource-binding gates ---------------------------------------------
// Each of these answers "is it legal to bind this resource now", separate
// from "is it legal to advance". Binding and advancing are two writes in
// one transaction at the call site, but they are two different questions:
// an operator may legitimately re-assign a number to a client who is
// already live (a number gone bad), without moving his status.

/** A WhatsApp connection can be bound from `contract_signed` onward — and
 *  re-bound later, because a client who reconnects Meta after a token
 *  expiry must not have to redo his whole onboarding. */
export function canBindMetaConnection(status: string): boolean {
  return status !== 'cancelled' && status !== 'paid';
}

/** A virtual number can be bound once WhatsApp is connected, and re-bound
 *  at any point after that (numbers get flagged and need replacing). */
export function canBindVirtualNumber(status: string): boolean {
  const index = ONBOARDING_SEQUENCE.indexOf(status as RecallStatus);
  return status !== 'cancelled' && index >= ONBOARDING_SEQUENCE.indexOf('meta_connected');
}

/** The Google Business location for the review half. Bindable at any point
 *  in a live-or-onboarding subscription: the reviews half is independent
 *  of the telephony half and a client may connect Google late. */
export function canBindGoogleConnection(status: string): boolean {
  return status !== 'cancelled';
}

/** The owner records his greeting on his phone and sends it over WhatsApp.
 *  Allowed from `meta_connected` (that is the channel it arrives on) and
 *  re-recordable forever after — he will want to change it. */
export function canRecordGreeting(status: string): boolean {
  const index = ONBOARDING_SEQUENCE.indexOf(status as RecallStatus);
  return status !== 'cancelled' && index >= ONBOARDING_SEQUENCE.indexOf('meta_connected');
}

// --- Side exits ----------------------------------------------------------

/** Pausing suspends answering without tearing down the setup — for a
 *  seasonal trade, a holiday, or a billing problem. Only meaningful once
 *  the service is actually live; pausing a half-built onboarding is just
 *  a stalled onboarding, which the stuck queue already surfaces. */
export function canPause(status: string): boolean {
  return status === 'active';
}

export function canResume(status: string): boolean {
  return status === 'paused';
}

/** Cancellable from anywhere except an already-cancelled row. Note this is
 *  the SERVICE being torn down (number released, forwarding to be undone
 *  by the client with ##61#), which is a different event from the Stripe
 *  subscription ending — those can happen in either order. */
export function canCancel(status: string): boolean {
  return status !== 'cancelled';
}

// --- Stuck detection -----------------------------------------------------
// The operator queue's whole purpose. Thresholds differ per state because
// what counts as "stuck" depends on who we are waiting for: chasing a
// client who hasn't signed is reasonable after a day, chasing Meta's
// review queue after one day is just noise.

const STUCK_AFTER_DAYS: Readonly<Partial<Record<RecallStatus, number>>> = {
  // Waiting on the client: chase early.
  paid: 1,
  contract_signed: 2,
  // Waiting on the client to complete Meta's Embedded Signup, which
  // includes Meta's own business verification — partly out of his hands.
  meta_connected: 3,
  // Waiting on us: a number should be assigned from the pool the same day.
  number_assigned: 1,
  // Waiting on Meta's template review. Their queue, their timeline.
  templates_approved: 4,
  // Waiting on the client to dial three MMI codes on his handset. THE
  // failure mode of this whole product: he pays, gets distracted, never
  // dials, and cancels at three weeks saying it did nothing. Chase hard.
  forwarding_pending: 1,
  forwarding_verified: 1,
};

/** Days after which a subscription sitting in `status` should be surfaced
 *  to an operator. Null when the state has no threshold (`active`,
 *  `paused`, `cancelled` are not stuck — they are resting states). */
export function stuckThresholdDays(status: string): number | null {
  return STUCK_AFTER_DAYS[status as RecallStatus] ?? null;
}

/** Whether a subscription that entered its current state at `since` is
 *  overdue as of `now`. Pure — the queue computes this at render time the
 *  same way the web-quote queue computes its stale badge, so there is no
 *  date arithmetic in the DB query. */
export function isStuck(status: string, since: Date, now: Date = new Date()): boolean {
  const threshold = stuckThresholdDays(status);
  if (threshold === null) return false;
  const elapsedDays = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays >= threshold;
}

// --- Operator queue ------------------------------------------------------

export interface RecallQueueRow {
  subscriptionId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  status: string;
  /** When the subscription entered its CURRENT state — the clock the
   *  stuck badge reads. */
  since: Date;
  e164: string | null;
  hasGreeting: boolean;
}

/**
 * Every subscription still mid-onboarding, for the operator's inbox.
 *
 * ONE query, deliberately. The nearest precedent in this codebase,
 * wizard-funnel's loadRowsFromDb, issues a query per client inside a
 * loop; listWebQuoteQueue is the shape to copy instead, and this follows
 * it. Nothing here is computed in SQL that could be computed at render
 * time — `isStuck` runs against the returned rows, so there is no date
 * arithmetic in the query and the thresholds stay in one testable place.
 *
 * `greetingAudio` is selected as a boolean-ish presence check rather than
 * pulled down: it is a BYTEA of a couple hundred KB per row and the queue
 * only needs to know whether it exists.
 */
export async function listRecallQueue(prisma: PrismaClient): Promise<RecallQueueRow[]> {
  const rows = await prisma.recallSubscription.findMany({
    where: { status: { in: ONBOARDING_SEQUENCE.filter((s) => s !== 'active') } },
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      clientId: true,
      status: true,
      updatedAt: true,
      contractSignedAt: true,
      metaConnectedAt: true,
      numberAssignedAt: true,
      templatesApprovedAt: true,
      forwardingVerifiedAt: true,
      createdAt: true,
      greetingRecordedAt: true,
      client: { select: { name: true, companyName: true, email: true } },
      virtualNumber: { select: { e164: true } },
    },
  });

  return rows.map((row) => ({
    subscriptionId: row.id,
    clientId: row.clientId,
    clientName: row.client.companyName ?? row.client.name,
    clientEmail: row.client.email,
    status: row.status,
    since: enteredCurrentStateAt(row),
    e164: row.virtualNumber?.e164 ?? null,
    hasGreeting: row.greetingRecordedAt !== null,
  }));
}

/**
 * When this subscription entered the state it is in now.
 *
 * Each transition seals its own timestamp (see the schema), so the clock
 * for "stuck in X" is the stamp of the transition that PUT it in X — not
 * `updatedAt`, which any unrelated edit would reset and thereby hide a
 * client who has been stalled for a week.
 */
function enteredCurrentStateAt(row: {
  status: string;
  createdAt: Date;
  contractSignedAt: Date | null;
  metaConnectedAt: Date | null;
  numberAssignedAt: Date | null;
  templatesApprovedAt: Date | null;
  forwardingVerifiedAt: Date | null;
}): Date {
  switch (row.status) {
    case 'paid':
      return row.createdAt;
    case 'contract_signed':
      return row.contractSignedAt ?? row.createdAt;
    case 'meta_connected':
      return row.metaConnectedAt ?? row.createdAt;
    case 'number_assigned':
      return row.numberAssignedAt ?? row.createdAt;
    case 'templates_approved':
      return row.templatesApprovedAt ?? row.createdAt;
    // forwarding_pending is entered by the same act that approved the
    // templates — there is no separate stamp, and adding one would record
    // the same instant twice.
    case 'forwarding_pending':
      return row.templatesApprovedAt ?? row.createdAt;
    case 'forwarding_verified':
      return row.forwardingVerifiedAt ?? row.createdAt;
    default:
      return row.createdAt;
  }
}
