// =============================================================================
// WP-XX — unit tests for the self-hosted Whisper client.
//
// The interesting property is the `retryable` flag: it is what stops the
// sweep from burning cycles forever on a recording that is genuinely
// gone, while still guaranteeing eventual completion for a transient
// outage. Every branch of that decision is covered.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribeRecording, isWhisperConfigured } from '@/lib/whisper';

const REC_URL = 'https://api.twilio.com/rec/RE1';
const originalFetch = globalThis.fetch;

function audioResponse(bytes = 128) {
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Response;
}
function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  process.env.WHISPER_BASE_URL = 'http://whisper:9000';
  delete process.env.WHISPER_LANGUAGE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('isWhisperConfigured', () => {
  it('is false without a base url', () => {
    delete process.env.WHISPER_BASE_URL;
    expect(isWhisperConfigured()).toBe(false);
  });

  it('is true once one is set', () => {
    expect(isWhisperConfigured()).toBe(true);
  });
});

describe('transcribeRecording', () => {
  it('reports not-configured as retryable — config may arrive later', async () => {
    delete process.env.WHISPER_BASE_URL;
    await expect(transcribeRecording(REC_URL)).resolves.toEqual({
      ok: false,
      error: 'whisper_not_configured',
      retryable: true,
    });
  });

  it('fetches the mp3 variant and posts it to the OpenAI-compatible endpoint', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push([String(url), init]);
      return calls.length === 1 ? audioResponse() : jsonResponse({ text: 'tengo una fuga' });
    }) as unknown as typeof fetch;

    await expect(transcribeRecording(REC_URL)).resolves.toEqual({ ok: true, text: 'tengo una fuga' });

    // .mp3 rather than raw WAV: a third of the bytes for speech.
    expect(calls[0][0]).toBe(`${REC_URL}.mp3`);
    expect(calls[1][0]).toBe('http://whisper:9000/v1/audio/transcriptions');
    expect(calls[1][1]?.method).toBe('POST');
  });

  it('sends Twilio Basic auth when credentials are supplied — a plain GET is 401', async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string> | undefined);
      return headers.length === 1 ? audioResponse() : jsonResponse({ text: 'ok' });
    }) as unknown as typeof fetch;

    await transcribeRecording(REC_URL, { auth: { accountSid: 'AC1', authToken: 'tok' } });

    const expected = `Basic ${Buffer.from('AC1:tok').toString('base64')}`;
    expect(headers[0]?.Authorization).toBe(expected);
  });

  it('defaults the language to Spanish and honours an override', async () => {
    let sentLanguage: unknown;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('.mp3')) return audioResponse();
      sentLanguage = (init?.body as FormData).get('language');
      return jsonResponse({ text: 'ok' });
    }) as unknown as typeof fetch;

    await transcribeRecording(REC_URL);
    expect(sentLanguage).toBe('es');

    process.env.WHISPER_LANGUAGE = 'pt';
    await transcribeRecording(REC_URL);
    expect(sentLanguage).toBe('pt');
  });

  it('treats a vanished recording as NOT retryable — it cannot come back', async () => {
    for (const status of [404, 410]) {
      globalThis.fetch = vi.fn(async () => ({ ok: false, status }) as unknown as Response) as unknown as typeof fetch;
      await expect(transcribeRecording(REC_URL)).resolves.toEqual({
        ok: false,
        error: `recording_fetch_${status}`,
        retryable: false,
      });
    }
  });

  it('treats a transient fetch failure as retryable', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    await expect(transcribeRecording(REC_URL)).resolves.toEqual({
      ok: false,
      error: 'recording_fetch_503',
      retryable: true,
    });
  });

  it('treats an empty audio file as permanent', async () => {
    globalThis.fetch = vi.fn(async () => audioResponse(0)) as unknown as typeof fetch;
    await expect(transcribeRecording(REC_URL)).resolves.toEqual({
      ok: false,
      error: 'recording_empty',
      retryable: false,
    });
  });

  it('retries Whisper 5xx and 429, but not a 4xx it will keep rejecting', async () => {
    const cases: Array<[number, boolean]> = [
      [500, true],
      [503, true],
      [429, true],
      [415, false],
    ];
    for (const [status, retryable] of cases) {
      globalThis.fetch = vi.fn(async (url: unknown) =>
        String(url).endsWith('.mp3') ? audioResponse() : jsonResponse(null, status),
      ) as unknown as typeof fetch;
      await expect(transcribeRecording(REC_URL)).resolves.toEqual({
        ok: false,
        error: `whisper_${status}`,
        retryable,
      });
    }
  });

  it('treats a successful call that produced no words as permanent, not an error to retry', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).endsWith('.mp3') ? audioResponse() : jsonResponse({ text: '   ' }),
    ) as unknown as typeof fetch;

    // Silence, or a clip too short to contain speech. Real outcome.
    await expect(transcribeRecording(REC_URL)).resolves.toEqual({
      ok: false,
      error: 'transcription_empty',
      retryable: false,
    });
  });

  it('reports a network throw as retryable rather than propagating it', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(transcribeRecording(REC_URL)).resolves.toEqual({
      ok: false,
      error: 'ECONNREFUSED',
      retryable: true,
    });
  });

  it('reports a timeout as retryable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;

    await expect(transcribeRecording(REC_URL, { timeoutMs: 1 })).resolves.toEqual({
      ok: false,
      error: 'timeout',
      retryable: true,
    });
  });

  it('trims surrounding whitespace from the transcript', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).endsWith('.mp3') ? audioResponse() : jsonResponse({ text: '  hola  ' }),
    ) as unknown as typeof fetch;
    await expect(transcribeRecording(REC_URL)).resolves.toEqual({ ok: true, text: 'hola' });
  });
});
