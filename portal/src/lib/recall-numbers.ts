import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { canBindVirtualNumber } from './recall';
import type { TelephonyProvider } from './telephony';
import { logError } from './observability';

// =============================================================================
// WP-XX — pool operations for the 'recall' product's virtual numbers.
//
// Three verbs: fill the pool (provision), claim from it (assign), give
// back (release). The provider is injected rather than imported so tests
// drive the real logic against the in-memory fake — see telephony/fake.ts.
//
// The ordering rule this module exists to enforce: WHEN THE PROVIDER AND
// THE DATABASE DISAGREE, THE DATABASE MUST BE THE CONSERVATIVE ONE.
//   - Provisioning writes the row only AFTER the provider confirms, so we
//     never claim to own a number we don't.
//   - Releasing marks the row released only AFTER the provider confirms,
//     so a number we're still being billed for never silently vanishes
//     from our own inventory.
// The failure mode we accept in exchange is a number that exists at the
// provider but not here — visible on the provider's invoice, and cheap to
// reconcile. The one we refuse is a number we think we own and don't,
// because that one hands a client a phone line that was never bought.
// =============================================================================

export interface ProvisionPoolResult {
  provisioned: Array<{ id: string; e164: string; providerSid: string }>;
  failed: Array<{ e164: string; error: string }>;
}

/**
 * Buy up to `count` numbers and add them to the pool.
 *
 * Best-effort per number: one failure does not abort the batch, because
 * the common failure (Twilio 21422 — someone else bought that number
 * between our search and our purchase) is per-candidate and retryable by
 * simply moving to the next one.
 */
export async function provisionIntoPool(
  prisma: PrismaClient,
  provider: TelephonyProvider,
  opts: { countryCode: string; count: number; areaCode?: string; voiceWebhookUrl?: string },
): Promise<ProvisionPoolResult | { error: string }> {
  const search = await provider.searchAvailableNumbers({
    countryCode: opts.countryCode,
    areaCode: opts.areaCode,
    // Over-fetch: candidates go stale between search and purchase, so ask
    // for more than we intend to buy rather than coming up short.
    limit: Math.max(opts.count * 3, opts.count + 5),
  });
  if (!search.ok) return { error: search.error };

  const result: ProvisionPoolResult = { provisioned: [], failed: [] };

  for (const candidate of search.data) {
    if (result.provisioned.length >= opts.count) break;

    const bought = await provider.provisionNumber({
      e164: candidate.e164,
      voiceWebhookUrl: opts.voiceWebhookUrl,
      friendlyName: `Kairikos recall ${candidate.e164}`,
    });
    if (!bought.ok) {
      result.failed.push({ e164: candidate.e164, error: bought.error });
      continue;
    }

    try {
      const row = await prisma.virtualNumber.create({
        data: {
          provider: provider.name,
          providerSid: bought.data.providerSid,
          e164: bought.data.e164,
          countryCode: bought.data.countryCode,
          status: 'available',
        },
      });
      result.provisioned.push({ id: row.id, e164: row.e164, providerSid: row.providerSid });
    } catch (err) {
      // Bought at the provider but not recorded here. Log loudly with the
      // SID: this is the reconcilable direction of the failure, but only
      // if the SID is findable afterwards.
      logError('recall_numbers.provision_persist_failed', err, {
        providerSid: bought.data.providerSid,
        e164: bought.data.e164,
      });
      result.failed.push({ e164: candidate.e164, error: 'provisioned_but_not_persisted' });
    }
  }

  return result;
}

export type AssignNumberResult =
  | { ok: true; numberId: string; e164: string }
  | { ok: false; error: 'subscription_not_found' | 'invalid_status' | 'already_assigned' | 'pool_empty' };

/**
 * Claim an available number for a subscription.
 *
 * Purely local — no provider call — which is the entire point of the
 * pool: the alta never waits on Twilio. Gated on canBindVirtualNumber()
 * so the rule lives in one place (recall.ts) rather than being restated
 * by every caller.
 *
 * The claim is a conditional UPDATE inside a transaction rather than a
 * read-then-write, so two operators assigning at the same moment cannot
 * hand the same number to two clients: the second update matches zero
 * rows and retries against the next candidate.
 */
export async function assignNumberToSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
  opts: { countryCode?: string } = {},
): Promise<AssignNumberResult> {
  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, status: true, virtualNumber: { select: { id: true } } },
  });
  if (!subscription) return { ok: false, error: 'subscription_not_found' };
  if (!canBindVirtualNumber(subscription.status)) return { ok: false, error: 'invalid_status' };
  if (subscription.virtualNumber) return { ok: false, error: 'already_assigned' };

  // Bounded retry: each miss means another operator claimed that row
  // between our read and our write, so try the next candidate.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await prisma.virtualNumber.findFirst({
      where: {
        status: 'available',
        subscriptionId: null,
        ...(opts.countryCode ? { countryCode: opts.countryCode } : {}),
      },
      orderBy: { provisionedAt: 'asc' },
      select: { id: true, e164: true },
    });
    if (!candidate) return { ok: false, error: 'pool_empty' };

    const claimed = await prisma.virtualNumber.updateMany({
      // The `status`/`subscriptionId` predicates are the compare-and-swap:
      // they only match while the row is still genuinely unclaimed.
      where: { id: candidate.id, status: 'available', subscriptionId: null },
      data: { status: 'assigned', subscriptionId, assignedAt: new Date() },
    });
    if (claimed.count === 1) {
      return { ok: true, numberId: candidate.id, e164: candidate.e164 };
    }
  }

  return { ok: false, error: 'pool_empty' };
}

export type ReleaseNumberResult =
  | { ok: true }
  | { ok: false; error: 'number_not_found' | 'already_released' | 'provider_failed'; detail?: string };

/**
 * Give a number back to the provider and mark it released.
 *
 * Provider first, database second — see this module's header. If the
 * provider rejects the release, the row keeps its current status and
 * records `lastError`, so the number stays visibly ours (and visibly
 * broken) rather than disappearing from inventory while still billing.
 */
export async function releaseNumber(
  prisma: PrismaClient,
  provider: TelephonyProvider,
  numberId: string,
): Promise<ReleaseNumberResult> {
  const row = await prisma.virtualNumber.findUnique({
    where: { id: numberId },
    select: { id: true, status: true, providerSid: true },
  });
  if (!row) return { ok: false, error: 'number_not_found' };
  if (row.status === 'released') return { ok: false, error: 'already_released' };

  const released = await provider.releaseNumber(row.providerSid);
  if (!released.ok) {
    await prisma.virtualNumber
      .update({ where: { id: numberId }, data: { lastError: released.error.slice(0, 500) } })
      .catch(() => null);
    return { ok: false, error: 'provider_failed', detail: released.error };
  }

  await prisma.virtualNumber.update({
    where: { id: numberId },
    data: { status: 'released', subscriptionId: null, releasedAt: new Date(), lastError: null },
  });
  return { ok: true };
}

export interface PoolSummary {
  available: number;
  assigned: number;
  released: number;
}

/** Pool depth, for the operator panel. A pool running dry is an
 *  onboarding outage waiting to happen, so this is worth surfacing
 *  before it hits zero. */
export async function getPoolSummary(prisma: PrismaClient): Promise<PoolSummary> {
  const grouped = await prisma.virtualNumber.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const counts: PoolSummary = { available: 0, assigned: 0, released: 0 };
  for (const row of grouped) {
    if (row.status === 'available') counts.available = row._count._all;
    else if (row.status === 'assigned') counts.assigned = row._count._all;
    else if (row.status === 'released') counts.released = row._count._all;
  }
  return counts;
}
