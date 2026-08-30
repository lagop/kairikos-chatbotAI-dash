import { type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { verifyTwilioSignature, resolveWebhookUrl, formDataToParams } from '@/lib/telephony/twilio-signature';
import {
  resolveCallTarget,
  recordIncomingCall,
  verifyForwardingFromCall,
  buildRecordTwiml,
  buildUnavailableTwiml,
  isWithheldCaller,
} from '@/lib/recall-calls';
import { isNumberBlocked } from '@/lib/recall-blocklist';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PATH = '/api/webhooks/twilio/voice';

function twiml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}

/**
 * POST /api/webhooks/twilio/voice
 *
 * Twilio calls this when a forwarded call lands on one of our virtual
 * numbers — i.e. when a client did not answer their own phone.
 *
 * PUBLIC endpoint: no session, no shared-secret header. The Twilio
 * signature is the only authentication, and it is mandatory. Without it
 * anyone who guessed this URL could fabricate calls and make the portal
 * message real people from a client's WhatsApp number.
 *
 * Every failure path still answers with valid TwiML, never an error
 * status. A real person is on the line: an HTTP error makes Twilio play
 * its own failure tone, so a misconfiguration on our side would be
 * audible to the caller as a broken business.
 */
export async function POST(req: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !isDatabaseConfigured) {
    // Deliberately not 503: see the header — the caller must hear a
    // polite message, not Twilio's error tone.
    return twiml(buildUnavailableTwiml());
  }

  let params: Record<string, string>;
  try {
    params = formDataToParams(await req.formData());
  } catch {
    return twiml(buildUnavailableTwiml(), 400);
  }

  const url = resolveWebhookUrl(req, PATH);
  if (!verifyTwilioSignature(authToken, url, params, req.headers.get('x-twilio-signature'))) {
    // 403 with no TwiML: a request that fails signature verification is
    // not a real caller, so there is nobody to be polite to. Logged
    // because a sudden run of these is either an attack or a proxy
    // misconfiguration, and both need looking at.
    logError(
      'twilio_voice.signature_invalid',
      new Error('signature verification failed'),
      { url, callSid: params.CallSid ?? null },
      'warn',
    );
    return new Response('forbidden', { status: 403 });
  }

  const callSid = params.CallSid;
  const to = params.To;
  if (!callSid || !to) return twiml(buildUnavailableTwiml(), 400);

  try {
    const target = await resolveCallTarget(prisma, to);
    if (!target) {
      // Unassigned number, or a subscription that is paused or still
      // onboarding. Answering with the record flow would take a message
      // nobody is watching.
      return twiml(buildUnavailableTwiml());
    }

    // The blocklist is checked HERE, before anything is recorded, not
    // just at send time. A known sales robot should not have its voice
    // captured, stored on Twilio for thirty days, and pushed through
    // Whisper — the cheapest and most defensible thing to do with data
    // we already know we will never use is to not collect it.
    const from = params.From ?? null;
    // Failing this ONE query must not cost a legitimate caller the
    // greeting: erring towards "not blocked" risks messaging a robot
    // once, while erring the other way breaks every real call.
    const blocked =
      from !== null &&
      !isWithheldCaller(from) &&
      (await isNumberBlocked(prisma, target.subscriptionId, from).catch(() => false));
    if (blocked && from) {
      await recordIncomingCall(prisma, target, { callSid, from, to, outcome: 'blocked' });
      // The call still reached our number — forwarding worked — whether
      // or not the caller turned out to be someone we block.
      await verifyForwardingFromCall(prisma, target).catch((err) => {
        logError('twilio_voice.forwarding_verification_failed', err, { callSid, subscriptionId: target.subscriptionId }, 'warn');
      });
      return twiml(buildUnavailableTwiml());
    }

    await recordIncomingCall(prisma, target, { callSid, from, to });
    await verifyForwardingFromCall(prisma, target).catch((err) => {
      logError('twilio_voice.forwarding_verification_failed', err, { callSid, subscriptionId: target.subscriptionId }, 'warn');
    });

    const base = resolveWebhookUrl(req, '');
    return twiml(
      buildRecordTwiml({
        greetingUrl: target.hasGreeting ? `${base}/api/webhooks/twilio/greeting/${target.subscriptionId}` : null,
        recordingCallbackUrl: `${base}/api/webhooks/twilio/recording`,
      }),
    );
  } catch (err) {
    // The call is happening whether or not our database is well. Take
    // the message anyway: a recording we can reconcile later beats a
    // lost call, which is the exact thing the client pays us to prevent.
    logError('twilio_voice.handler_failed', err, { callSid });
    const base = resolveWebhookUrl(req, '');
    return twiml(
      buildRecordTwiml({ greetingUrl: null, recordingCallbackUrl: `${base}/api/webhooks/twilio/recording` }),
    );
  }
}
