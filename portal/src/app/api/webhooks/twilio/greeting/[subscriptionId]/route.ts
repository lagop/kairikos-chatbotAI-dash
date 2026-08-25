import { type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/webhooks/twilio/greeting/[subscriptionId]
 *
 * Serves the owner's own recorded greeting so Twilio's `<Play>` can fetch
 * it mid-call.
 *
 * PUBLIC and unauthenticated by necessity: Twilio's media fetcher sends
 * no credentials and cannot be made to. The exposure is bounded and
 * deliberate — this is a business's outgoing answerphone greeting, the
 * same twenty seconds any member of the public hears by ringing the
 * number and not being answered. There is nothing here that is not
 * already public to anyone who dials.
 *
 * Two things keep it honest: the id is a UUID, so the set is not
 * enumerable, and only a subscription that is actually `active` serves
 * audio — a cancelled client's voice stops being reachable the moment
 * their service ends.
 *
 * Deliberately NOT cached: the owner re-records his greeting from his own
 * phone and expects the next caller to hear the new one. Twilio caches
 * media aggressively unless told otherwise.
 */
export async function GET(_req: NextRequest, { params }: { params: { subscriptionId: string } }) {
  if (!isDatabaseConfigured) return new Response('service_unavailable', { status: 503 });

  const subscription = await prisma.recallSubscription
    .findUnique({
      where: { id: params.subscriptionId },
      select: { status: true, greetingAudio: true, greetingMimeType: true },
    })
    .catch(() => null);

  if (!subscription || subscription.status !== 'active' || !subscription.greetingAudio) {
    // 404 rather than a placeholder sound: the voice webhook already
    // decided whether a greeting exists and falls back to a neutral
    // spoken message when it does not, so reaching here means something
    // changed mid-call and silence is the honest answer.
    return new Response('not_found', { status: 404 });
  }

  return new Response(Buffer.from(subscription.greetingAudio), {
    status: 200,
    headers: {
      'content-type': subscription.greetingMimeType ?? 'audio/mpeg',
      'content-length': String(subscription.greetingAudio.length),
      'cache-control': 'no-store',
    },
  });
}
