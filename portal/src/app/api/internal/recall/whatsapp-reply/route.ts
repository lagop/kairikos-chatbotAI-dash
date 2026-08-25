import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { applyDigestReply } from '@/lib/recall-reviews';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP-XX (Fase 10) — POST /api/internal/recall/whatsapp-reply
//
// The owner answers his 19:00 digest with "1 y 3". Meta delivers that to
// n8n, which already forwards inbound WhatsApp to
// /api/internal/channels/whatsapp/message (the chatbot conversation
// route). This is its sibling: n8n tries this one FIRST, and only falls
// through to the conversation route when this answers `handled: false`.
//
// That ordering, rather than a flag in n8n, is deliberate. Whether a
// message is a digest reply depends on facts only the portal has — is the
// sender this client's owner, and is there a digest from the last twenty
// hours he could be answering — and duplicating that test in a workflow
// is how the two definitions drift apart.
//
// A message that is NOT a digest reply is not an error. `handled: false`
// with 200 is the normal answer for "this is ordinary conversation", and
// n8n routes it onward.
// =============================================================================

const BodySchema = z.object({
  /** The Meta phone_number_id the message arrived on — identifies which
   *  client's WhatsApp this is. */
  phoneNumberId: z.string().trim().min(1),
  /** The sender's wa_id (their phone number). */
  from: z.string().trim().min(1),
  text: z.string().trim().min(1).max(1000),
});

/** Compare two phone numbers the way a human means it. Meta's `wa_id`
 *  omits the leading '+' that we store, and a client may have typed his
 *  own number with spaces — so a naive === would silently never match the
 *  owner and every digest reply would fall through as conversation. */
function sameNumber(a: string, b: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, '');
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  // One may carry a country code the other omits.
  return x === y || x.endsWith(y) || y.endsWith(x);
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'whatsapp', externalId: body.data.phoneNumberId, status: 'active' },
    select: { id: true, clientId: true },
  });
  if (!connection) {
    return NextResponse.json({ handled: false, reason: 'unknown_number' });
  }

  const subscription = await prisma.recallSubscription.findFirst({
    where: { clientId: connection.clientId, status: 'active' },
    select: { id: true, ownerWhatsapp: true },
  });
  if (!subscription?.ownerWhatsapp) {
    return NextResponse.json({ handled: false, reason: 'no_subscription' });
  }

  // Only the owner can answer his own digest. Without this check any
  // customer replying "1" to an unrelated message would be requesting
  // review invitations on the client's behalf.
  if (!sameNumber(subscription.ownerWhatsapp, body.data.from)) {
    return NextResponse.json({ handled: false, reason: 'not_owner' });
  }

  const outcome = await applyDigestReply(prisma, {
    subscriptionId: subscription.id,
    text: body.data.text,
  });

  if (outcome.status === 'ignored' && outcome.reason === 'no_open_digest') {
    // No digest to answer means this really was ordinary conversation.
    return NextResponse.json({ handled: false, reason: 'no_open_digest' });
  }

  return NextResponse.json({ handled: true, outcome });
}
