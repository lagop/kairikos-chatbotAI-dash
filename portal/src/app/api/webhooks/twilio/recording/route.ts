import { type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { verifyTwilioSignature, resolveWebhookUrl, formDataToParams } from '@/lib/telephony/twilio-signature';
import { attachRecording } from '@/lib/recall-calls';
import { transcribeCallEventInBackground } from '@/lib/recall-transcription';
import { notifyOwnerInBackground } from '@/lib/recall-messaging';
import { resolveActiveTwilioCredentials } from '@/lib/twilio-credentials';
import { logError } from '@/lib/observability';
import { isTwilioRecordingUrl } from '@/lib/twilio-recording-url';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PATH = '/api/webhooks/twilio/recording';

/**
 * POST /api/webhooks/twilio/recording
 *
 * Fires when the recording of a message is ready. Same public-endpoint
 * posture as the voice webhook: the Twilio signature is the only
 * authentication.
 *
 * Unlike the voice webhook, nobody is on the line here, so the response
 * codes are ordinary HTTP. That matters in one direction: a 5xx makes
 * Twilio RETRY, which is what we want when our database is briefly down
 * — the recording is not lost, it arrives again. A 200 tells Twilio to
 * stop, so it is reserved for "we have it" and for permanent failures
 * retrying could never fix.
 *
 * The audio is never downloaded. We keep the SID and URL; the 30-day
 * purge (Fase 6) deletes it at Twilio, which is where the RGPD retention
 * promise is actually kept.
 */
export async function POST(req: NextRequest) {
  const credentials = await resolveActiveTwilioCredentials();
  const authToken = credentials?.authToken ?? null;
  if (!authToken) return new Response('not_configured', { status: 503 });
  if (!isDatabaseConfigured) return new Response('service_unavailable', { status: 503 });

  let params: Record<string, string>;
  try {
    params = formDataToParams(await req.formData());
  } catch {
    return new Response('bad_request', { status: 400 });
  }

  const url = resolveWebhookUrl(req, PATH);
  if (!verifyTwilioSignature(authToken, url, params, req.headers.get('x-twilio-signature'))) {
    logError(
      'twilio_recording.signature_invalid',
      new Error('signature verification failed'),
      { url, callSid: params.CallSid ?? null },
      'warn',
    );
    return new Response('forbidden', { status: 403 });
  }

  const callSid = params.CallSid;
  const recordingSid = params.RecordingSid;
  const recordingUrl = params.RecordingUrl;
  if (!callSid || !recordingSid || !recordingUrl) {
    return new Response('bad_request', { status: 400 });
  }
  // Firmado por Twilio, pero se guarda una URL que luego se descarga con las
  // credenciales de la cuenta: solo si es de Twilio (lib/twilio-recording-url.ts).
  // 200, no 4xx: reintentar no la va a cambiar.
  if (!isTwilioRecordingUrl(recordingUrl)) {
    logError('twilio_recording.url_rejected', new Error('not_a_twilio_recording_url'), { callSid }, 'warn');
    return new Response('ignored', { status: 200 });
  }

  const durationRaw = params.RecordingDuration;
  const parsedDuration = durationRaw === undefined ? NaN : Number.parseInt(durationRaw, 10);
  const durationSeconds = Number.isFinite(parsedDuration) ? parsedDuration : null;

  try {
    const result = await attachRecording(prisma, { callSid, recordingSid, recordingUrl, durationSeconds });
    if (!result.ok) {
      // The call row genuinely does not exist. Retrying will not conjure
      // it, so 200 to stop Twilio re-delivering forever — but log it,
      // because it means a recording exists at Twilio with nothing
      // pointing at it, and the purge job will never find it.
      logError('twilio_recording.orphan', new Error('recording for unknown call'), { callSid, recordingSid }, 'warn');
      return new Response(JSON.stringify({ status: 'orphan' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Fire and forget: transcription takes seconds and this callback must
    // return promptly, or Twilio treats it as failed and re-delivers.
    // Whatever this misses, the scheduler's sweep picks up — which is why
    // it is safe not to await, and why the sweep exists at all.
    // The owner's message is chained after the transcription attempt
    // rather than left to the sweep, because "se enteró en segundos" is
    // the thing the client is actually paying for. It runs even when
    // transcription failed: notifyOwner has its own grace period and
    // "alguien llamó y dejó un mensaje" still beats silence.
    //
    // The CALLER's message is deliberately NOT sent here — it owes a
    // 90-second pause, and the sweep is what serves it.
    // Las dos mitades de la credencial salen del MISMO sitio. El token ya
    // venía de resolveActiveTwilioCredentials (la fila cifrada en
    // Postgres, que es donde el operador las guarda), pero el SID se leía
    // de TWILIO_ACCOUNT_SID — vacía en la VPS, porque las credenciales de
    // Twilio se gestionan por pantalla y no por entorno. Sin SID no se
    // mandaba ninguna autenticación y Twilio devolvía 401 al descargar la
    // grabación: `transcription_error: recording_fetch_401`.
    //
    // No se notaba porque el barrido del cron —que sí resuelve las dos
    // mitades juntas— rehacía el trabajo en el siguiente tick. O sea: la
    // transcripción inmediata NUNCA ha funcionado en producción, y todas
    // las llamadas se transcribían con hasta 5 minutos de retraso.
    // Comprobado con una llamada real el 23/09/2026.
    const accountSid = credentials?.accountSid ?? null;
    transcribeCallEventInBackground(
      prisma,
      result.callEventId,
      accountSid ? { accountSid, authToken } : undefined,
      () => notifyOwnerInBackground(prisma, result.callEventId),
    );

    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    // 500 on purpose: Twilio retries, and a transient database problem
    // must not lose the only pointer to a client's message.
    logError('twilio_recording.handler_failed', err, { callSid, recordingSid });
    return new Response('error', { status: 500 });
  }
}
