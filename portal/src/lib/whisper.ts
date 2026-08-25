import 'server-only';
import { logError } from './observability';

// =============================================================================
// WP-XX — client for the self-hosted Whisper service.
//
// Self-hosted rather than a transcription API, for two reasons that both
// matter more than the (negligible) cost difference:
//
//   1. RGPD. We are the PROCESSOR and the client is the CONTROLLER of a
//      third party's recorded voice. Keeping transcription on the same
//      VPS means the caller's voice never leaves infrastructure the
//      client's own processing agreement already covers — no sub-processor
//      to declare, no transfer to assess.
//   2. Zero marginal cost. "Modo Recado" takes 30-60s messages, so a
//      50-client book is ~12 hours of audio a month, which a CPU handles
//      without noticing.
//
// The service is a `faster-whisper` container in docker-compose.yml
// speaking the OpenAI-compatible /v1/audio/transcriptions shape, which is
// what most self-hosted Whisper images expose. That compatibility is
// deliberate: if self-hosting ever becomes a burden, pointing
// WHISPER_BASE_URL at a hosted OpenAI-compatible endpoint is a config
// change, not a rewrite.
// =============================================================================

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; error: string; retryable: boolean };

export function isWhisperConfigured(): boolean {
  return Boolean(process.env.WHISPER_BASE_URL);
}

function baseUrl(): string {
  return (process.env.WHISPER_BASE_URL ?? '').replace(/\/+$/, '');
}

/** Language hint. Fixed to Spanish rather than left to auto-detect: the
 *  clips are short and noisy (someone calling from a building site), and
 *  auto-detection on a 5-second clip guesses wrong often enough to matter.
 *  Override per-deployment if the product ever sells outside Spanish. */
function language(): string {
  return process.env.WHISPER_LANGUAGE ?? 'es';
}

/**
 * Fetch a recording from the provider and transcribe it locally.
 *
 * The audio is streamed provider → portal → whisper and never written to
 * disk or to the database. What persists is the text.
 *
 * `retryable` distinguishes "try again later" (network, 5xx, timeout —
 * the sweep will pick it up) from "this will never work" (404 on the
 * recording, unsupported media), so the sweep does not burn cycles
 * forever on a recording that is genuinely gone.
 */
export async function transcribeRecording(
  recordingUrl: string,
  opts: { timeoutMs?: number; auth?: { accountSid: string; authToken: string } } = {},
): Promise<TranscriptionResult> {
  if (!isWhisperConfigured()) {
    return { ok: false, error: 'whisper_not_configured', retryable: true };
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Twilio recording URLs need the account's Basic auth; a plain GET
    // returns 401. The `.mp3` suffix asks Twilio for a compressed
    // encoding rather than raw WAV — a third of the bytes over the wire
    // for speech, and Whisper is indifferent.
    const headers: Record<string, string> = {};
    if (opts.auth) {
      headers.Authorization = `Basic ${Buffer.from(`${opts.auth.accountSid}:${opts.auth.authToken}`).toString('base64')}`;
    }
    const audioRes = await fetch(`${recordingUrl}.mp3`, { headers, signal: controller.signal });
    if (!audioRes.ok) {
      return {
        ok: false,
        error: `recording_fetch_${audioRes.status}`,
        // A 404 means the recording is gone (already purged, or never
        // finished). Retrying cannot bring it back.
        retryable: audioRes.status !== 404 && audioRes.status !== 410,
      };
    }
    const audio = await audioRes.arrayBuffer();
    if (audio.byteLength === 0) {
      return { ok: false, error: 'recording_empty', retryable: false };
    }

    const form = new FormData();
    form.set('file', new Blob([audio], { type: 'audio/mpeg' }), 'recording.mp3');
    form.set('model', process.env.WHISPER_MODEL ?? 'whisper-1');
    form.set('language', language());
    form.set('response_format', 'json');

    const res = await fetch(`${baseUrl()}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `whisper_${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    }

    const json = (await res.json().catch(() => null)) as { text?: string } | null;
    const text = json?.text?.trim();
    if (!text) {
      // A successful call that produced no words: silence, or a clip too
      // short to contain speech. Real outcome, nothing to retry.
      return { ok: false, error: 'transcription_empty', retryable: false };
    }
    return { ok: true, text };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    logError('whisper.transcribe_failed', err, { recordingUrl }, 'warn');
    return {
      ok: false,
      error: aborted ? 'timeout' : err instanceof Error ? err.message : 'unknown error',
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
