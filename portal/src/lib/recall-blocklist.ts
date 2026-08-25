import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// WP-XX (Fase 9) — numbers a client never wants messaged back.
//
// Small, but it is the difference between a product that helps and one
// that embarrasses its client: without it, the business's own WhatsApp
// answers every cold-call sales robot with a warm "¿en qué podemos
// ayudarte?". That costs money on the send, costs quality rating on the
// number, and costs the owner's patience when he sees it.
//
// Blocking is checked TWICE by design — once in the voice webhook, so a
// known robot never gets a recording made or a voice stored, and once
// again at send time, so a number blocked in the minutes between the call
// and the message is still honoured.
// =============================================================================

/**
 * Normalise to the E.164 shape Twilio sends, so the list matches.
 *
 * This is the whole reason the function exists: an operator types
 * "651 23 45 67" and Twilio sends "+34651234567". A blocklist that stored
 * what was typed would look correct in the panel and silently never match
 * a single real call — the worst kind of bug, because nothing appears
 * broken.
 *
 * Spanish national numbers get the +34 they omitted. Anything already in
 * international form keeps its own prefix; anything that cannot be read
 * as a number at all returns null so the caller can reject it rather than
 * storing a row that will never match.
 */
export function normaliseE164(raw: string, defaultCountryPrefix = '+34'): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // '00' is how the rest of the world writes '+'.
  const withPlus = trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
  const hasPlus = withPlus.startsWith('+');
  const digits = withPlus.replace(/\D/g, '');
  if (digits.length < 6) return null;

  if (hasPlus) return `+${digits}`;
  // A bare Spanish national number is nine digits.
  if (digits.length === 9) return `${defaultCountryPrefix}${digits}`;
  // Anything else without a '+' is ambiguous — refuse rather than guess.
  return null;
}

export async function isNumberBlocked(
  prisma: PrismaClient,
  subscriptionId: string,
  e164: string,
): Promise<boolean> {
  const row = await prisma.recallBlockedNumber.findUnique({
    where: { subscriptionId_e164: { subscriptionId, e164 } },
    select: { id: true },
  });
  return row !== null;
}

export type BlockResult =
  | { ok: true; id: string; e164: string }
  | { ok: false; error: 'invalid_number' | 'subscription_not_found' };

/**
 * Add a number to a subscription's blocklist.
 *
 * Upsert rather than create: blocking a number twice is the same block,
 * and an operator clicking twice must not see an error for having done
 * the thing they wanted.
 */
export async function blockNumber(
  prisma: PrismaClient,
  subscriptionId: string,
  rawNumber: string,
  meta: { reason?: string | null; createdBy?: string | null } = {},
): Promise<BlockResult> {
  const e164 = normaliseE164(rawNumber);
  if (!e164) return { ok: false, error: 'invalid_number' };

  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { clientId: true },
  });
  if (!subscription) return { ok: false, error: 'subscription_not_found' };

  const row = await prisma.recallBlockedNumber.upsert({
    where: { subscriptionId_e164: { subscriptionId, e164 } },
    create: {
      subscriptionId,
      clientId: subscription.clientId,
      e164,
      reason: meta.reason ?? null,
      createdBy: meta.createdBy ?? null,
    },
    // Re-blocking refreshes the reason — the second attempt is usually
    // the one where the operator bothered to explain why.
    update: { reason: meta.reason ?? null },
    select: { id: true },
  });

  return { ok: true, id: row.id, e164 };
}

/** Remove a block. Returns false when there was nothing to remove, which
 *  the route reports as 404 rather than pretending it did something. */
export async function unblockNumber(
  prisma: PrismaClient,
  subscriptionId: string,
  rawNumber: string,
): Promise<boolean> {
  const e164 = normaliseE164(rawNumber);
  if (!e164) return false;
  const deleted = await prisma.recallBlockedNumber.deleteMany({ where: { subscriptionId, e164 } });
  return deleted.count > 0;
}

export interface BlockedNumberRow {
  id: string;
  e164: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export function listBlockedNumbers(
  prisma: PrismaClient,
  subscriptionId: string,
): Promise<BlockedNumberRow[]> {
  return prisma.recallBlockedNumber.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, e164: true, reason: true, createdBy: true, createdAt: true },
  });
}
