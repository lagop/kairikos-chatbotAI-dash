// =============================================================================
// WP-XX — unit tests for the public Twilio webhooks.
//
// These are session-less endpoints on the open internet, so the tests
// lead with what must be REJECTED. The signature is built with the real
// implementation rather than mocked, so an unsigned or tampered request
// genuinely fails verification the way it would in production.
//
// The other property under test is the response CONTRACT, which is
// unusual here and easy to get wrong: the voice webhook must answer with
// valid TwiML on almost every failure (a real person is on the line and
// an HTTP error makes Twilio play its own failure tone), while the
// recording webhook must answer 5xx on transient failure so Twilio
// retries and the only pointer to a client's message is not lost.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { buildTwilioSignature } from '@/lib/telephony/twilio-signature';

const AUTH_TOKEN = 'test_auth_token';
const BASE = 'https://portal.example.com';

const mockState = vi.hoisted(() => ({
  resolveCallTarget: vi.fn(),
  recordIncomingCall: vi.fn(),
  attachRecording: vi.fn(),
  recallSubscriptionFindUnique: vi.fn(),
}));

vi.mock('@/lib/recall-calls', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recall-calls')>('@/lib/recall-calls');
  return {
    ...actual,
    resolveCallTarget: (...a: unknown[]) => mockState.resolveCallTarget(...a),
    recordIncomingCall: (...a: unknown[]) => mockState.recordIncomingCall(...a),
    attachRecording: (...a: unknown[]) => mockState.attachRecording(...a),
  };
});

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    recallSubscription: { findUnique: (...a: unknown[]) => mockState.recallSubscriptionFindUnique(...a) },
  },
}));

function makeRequest(path: string, params: Record<string, string>, opts: { sign?: boolean } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  const signature = opts.sign === false ? null : buildTwilioSignature(AUTH_TOKEN, `${BASE}${path}`, params);
  return {
    url: `http://internal:3000${path}`,
    headers: new Headers(signature ? { 'x-twilio-signature': signature } : {}),
    formData: async () => form,
  } as unknown as NextRequest;
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
  for (const fn of Object.values(mockState)) fn.mockReset();
});

describe('POST /api/webhooks/twilio/voice', () => {
  const PATH = '/api/webhooks/twilio/voice';
  const CALL = { CallSid: 'CA1', From: '+34600111222', To: '+34910000001' };
  const TARGET = {
    subscriptionId: 'sub_1',
    clientId: 'client_1',
    tenantId: 't1',
    virtualNumberId: 'vn_1',
    hasGreeting: true,
  };

  async function post(req: NextRequest) {
    const { POST } = await import('@/app/api/webhooks/twilio/voice/route');
    return POST(req);
  }

  it('403s an unsigned request and never touches the database', async () => {
    const res = await post(makeRequest(PATH, CALL, { sign: false }));
    expect(res.status).toBe(403);
    expect(mockState.resolveCallTarget).not.toHaveBeenCalled();
  });

  it('403s a request whose caller id was tampered with after signing', async () => {
    const form = new FormData();
    const tampered = { ...CALL, From: '+34600999999' };
    for (const [k, v] of Object.entries(tampered)) form.set(k, v);
    const req = {
      url: `http://internal:3000${PATH}`,
      // Signature is valid — but for the ORIGINAL params, not these.
      headers: new Headers({ 'x-twilio-signature': buildTwilioSignature(AUTH_TOKEN, `${BASE}${PATH}`, CALL) }),
      formData: async () => form,
    } as unknown as NextRequest;

    const res = await post(req);
    expect(res.status).toBe(403);
    expect(mockState.recordIncomingCall).not.toHaveBeenCalled();
  });

  it('answers a signed call with record TwiML pointing at the owner greeting', async () => {
    mockState.resolveCallTarget.mockResolvedValue(TARGET);
    mockState.recordIncomingCall.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });

    const res = await post(makeRequest(PATH, CALL));
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(xml).toContain(`<Play>${BASE}/api/webhooks/twilio/greeting/sub_1</Play>`);
    expect(xml).toContain(`recordingStatusCallback="${BASE}/api/webhooks/twilio/recording"`);
  });

  it('falls back to the neutral spoken greeting when the owner has not recorded one', async () => {
    mockState.resolveCallTarget.mockResolvedValue({ ...TARGET, hasGreeting: false });
    mockState.recordIncomingCall.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });

    const xml = await (await post(makeRequest(PATH, CALL))).text();
    expect(xml).not.toContain('<Play>');
    expect(xml).toContain('<Say language="es-ES">');
  });

  it('gives an unknown number a polite message, NOT an error status', async () => {
    mockState.resolveCallTarget.mockResolvedValue(null);
    const res = await post(makeRequest(PATH, CALL));
    const xml = await res.text();

    // A real person dialled a real business. An HTTP error here makes
    // Twilio play its own failure tone at them.
    expect(res.status).toBe(200);
    expect(xml).toContain('<Say language="es-ES">');
    expect(xml).not.toContain('<Record');
  });

  it('still takes the message when the database throws — a recording beats a lost call', async () => {
    mockState.resolveCallTarget.mockRejectedValue(new Error('db down'));
    const res = await post(makeRequest(PATH, CALL));
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(xml).toContain('<Record');
  });

  it('answers politely rather than 503 when telephony is unconfigured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await post(makeRequest(PATH, CALL, { sign: false }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Say');
  });

  it('400s a signed request missing CallSid or To', async () => {
    const res = await post(makeRequest(PATH, { From: '+34600111222' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/webhooks/twilio/recording', () => {
  const PATH = '/api/webhooks/twilio/recording';
  const REC = {
    CallSid: 'CA1',
    RecordingSid: 'RE1',
    RecordingUrl: 'https://api.twilio.com/rec/RE1',
    RecordingDuration: '17',
  };

  async function post(req: NextRequest) {
    const { POST } = await import('@/app/api/webhooks/twilio/recording/route');
    return POST(req);
  }

  it('403s an unsigned request', async () => {
    const res = await post(makeRequest(PATH, REC, { sign: false }));
    expect(res.status).toBe(403);
    expect(mockState.attachRecording).not.toHaveBeenCalled();
  });

  it('attaches a signed recording and parses its duration', async () => {
    mockState.attachRecording.mockResolvedValue({ ok: true, callEventId: 'ce_1' });
    const res = await post(makeRequest(PATH, REC));

    expect(res.status).toBe(200);
    expect(mockState.attachRecording).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callSid: 'CA1', recordingSid: 'RE1', durationSeconds: 17 }),
    );
  });

  it('treats an unparseable duration as unknown rather than zero', async () => {
    mockState.attachRecording.mockResolvedValue({ ok: true, callEventId: 'ce_1' });
    await post(makeRequest(PATH, { ...REC, RecordingDuration: 'abc' }));
    expect(mockState.attachRecording).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ durationSeconds: null }),
    );
  });

  it('200s an orphan recording so Twilio stops retrying something unfixable', async () => {
    mockState.attachRecording.mockResolvedValue({ ok: false, error: 'call_not_found' });
    const res = await post(makeRequest(PATH, REC));
    expect(res.status).toBe(200);
    expect((await res.clone().json()).status).toBe('orphan');
  });

  it('500s a transient failure so Twilio RETRIES — losing the pointer loses the message', async () => {
    mockState.attachRecording.mockRejectedValue(new Error('db down'));
    const res = await post(makeRequest(PATH, REC));
    expect(res.status).toBe(500);
  });

  it('400s a signed request missing the recording fields', async () => {
    const res = await post(makeRequest(PATH, { CallSid: 'CA1' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/webhooks/twilio/greeting/[subscriptionId]', () => {
  async function get(subscriptionId = 'sub_1') {
    const { GET } = await import('@/app/api/webhooks/twilio/greeting/[subscriptionId]/route');
    return GET({} as NextRequest, { params: { subscriptionId } });
  }

  it('serves the audio for an active subscription', async () => {
    mockState.recallSubscriptionFindUnique.mockResolvedValue({
      status: 'active',
      greetingAudio: Buffer.from('fake-audio'),
      greetingMimeType: 'audio/mpeg',
    });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    // Never cached: the owner re-records and expects the next caller to
    // hear the new one.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s once a subscription is no longer active — a cancelled client\'s voice stops being reachable', async () => {
    mockState.recallSubscriptionFindUnique.mockResolvedValue({
      status: 'cancelled',
      greetingAudio: Buffer.from('fake-audio'),
      greetingMimeType: 'audio/mpeg',
    });
    expect((await get()).status).toBe(404);
  });

  it('404s when no greeting has been recorded', async () => {
    mockState.recallSubscriptionFindUnique.mockResolvedValue({
      status: 'active',
      greetingAudio: null,
      greetingMimeType: null,
    });
    expect((await get()).status).toBe(404);
  });

  it('404s an unknown subscription', async () => {
    mockState.recallSubscriptionFindUnique.mockResolvedValue(null);
    expect((await get('sub_missing')).status).toBe(404);
  });
});
