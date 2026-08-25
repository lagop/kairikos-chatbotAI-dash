// =============================================================================
// WP-XX — unit tests for src/lib/recall-calls.ts (inbound call handling).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  isWithheldCaller,
  buildRecordTwiml,
  buildUnavailableTwiml,
  resolveCallTarget,
  recordIncomingCall,
  attachRecording,
} from '@/lib/recall-calls';

const state = {
  virtualNumberFindUnique: vi.fn(),
  callEventUpsert: vi.fn(),
  callEventFindUnique: vi.fn(),
  callEventUpdate: vi.fn(),
};

const prisma = {
  virtualNumber: { findUnique: (...a: unknown[]) => state.virtualNumberFindUnique(...a) },
  callEvent: {
    upsert: (...a: unknown[]) => state.callEventUpsert(...a),
    findUnique: (...a: unknown[]) => state.callEventFindUnique(...a),
    update: (...a: unknown[]) => state.callEventUpdate(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
});

describe('isWithheldCaller', () => {
  it.each(['anonymous', 'Anonymous', 'unavailable', 'restricted', 'private', '+266696687'])(
    'treats %s as withheld',
    (value) => {
      expect(isWithheldCaller(value)).toBe(true);
    },
  );

  it('treats a missing or empty caller id as withheld', () => {
    expect(isWithheldCaller(null)).toBe(true);
    expect(isWithheldCaller(undefined)).toBe(true);
    expect(isWithheldCaller('')).toBe(true);
  });

  it('treats a real number as callable', () => {
    expect(isWithheldCaller('+34600111222')).toBe(false);
  });
});

describe('buildRecordTwiml', () => {
  it('plays the owner\'s own recording when there is one', () => {
    const xml = buildRecordTwiml({
      greetingUrl: 'https://portal.example.com/greeting/abc',
      recordingCallbackUrl: 'https://portal.example.com/rec',
    });
    expect(xml).toContain('<Play>https://portal.example.com/greeting/abc</Play>');
    expect(xml).not.toContain('<Say');
  });

  it('falls back to a NEUTRAL voice that never claims to be the owner', () => {
    const xml = buildRecordTwiml({ greetingUrl: null, recordingCallbackUrl: 'https://portal.example.com/rec' });
    expect(xml).toContain('<Say language="es-ES">');
    // The fallback must not impersonate: no first-person business identity.
    expect(xml).toContain('Gracias por llamar');
    expect(xml).not.toContain('<Play>');
  });

  it('records with a recording callback and then hangs up', () => {
    const xml = buildRecordTwiml({ greetingUrl: null, recordingCallbackUrl: 'https://portal.example.com/rec' });
    expect(xml).toContain('recordingStatusCallback="https://portal.example.com/rec"');
    expect(xml).toContain('recordingStatusCallbackEvent="completed"');
    expect(xml).toContain('<Hangup/>');
  });

  it('caps the recording length so a pocket-dial cannot bill us for minutes', () => {
    expect(buildRecordTwiml({ greetingUrl: null, recordingCallbackUrl: 'x' })).toContain('maxLength="120"');
    expect(
      buildRecordTwiml({ greetingUrl: null, recordingCallbackUrl: 'x', maxLengthSeconds: 45 }),
    ).toContain('maxLength="45"');
  });

  it('escapes urls so a crafted value cannot inject TwiML', () => {
    const xml = buildRecordTwiml({
      greetingUrl: 'https://x/?a=1&b=2"/><Dial>+34600000000</Dial><Play url="',
      recordingCallbackUrl: 'https://portal.example.com/rec',
    });
    // The injected <Dial> must not survive as markup — otherwise a
    // poisoned url would place outbound calls on our account.
    expect(xml).not.toContain('<Dial>');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
  });
});

describe('buildUnavailableTwiml', () => {
  it('is valid TwiML with a spoken message, never an error', () => {
    const xml = buildUnavailableTwiml();
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Say language="es-ES">');
    expect(xml).toContain('<Hangup/>');
  });
});

describe('resolveCallTarget', () => {
  const ASSIGNED = {
    id: 'vn_1',
    status: 'assigned',
    subscription: {
      id: 'sub_1',
      clientId: 'client_1',
      tenantId: 'tenant_1',
      status: 'active',
      greetingAudio: Buffer.from('audio'),
    },
  };

  it('resolves an assigned number on an active subscription', async () => {
    state.virtualNumberFindUnique.mockResolvedValue(ASSIGNED);
    await expect(resolveCallTarget(prisma, '+34910000001')).resolves.toEqual({
      subscriptionId: 'sub_1',
      clientId: 'client_1',
      tenantId: 'tenant_1',
      virtualNumberId: 'vn_1',
      hasGreeting: true,
    });
  });

  it('reports no greeting when the owner has not recorded one', async () => {
    state.virtualNumberFindUnique.mockResolvedValue({
      ...ASSIGNED,
      subscription: { ...ASSIGNED.subscription, greetingAudio: null },
    });
    const target = await resolveCallTarget(prisma, '+34910000001');
    expect(target?.hasGreeting).toBe(false);
  });

  it('refuses an unknown number', async () => {
    state.virtualNumberFindUnique.mockResolvedValue(null);
    await expect(resolveCallTarget(prisma, '+34910000009')).resolves.toBeNull();
  });

  it('refuses a number still sitting in the pool', async () => {
    state.virtualNumberFindUnique.mockResolvedValue({ ...ASSIGNED, status: 'available', subscription: null });
    await expect(resolveCallTarget(prisma, '+34910000001')).resolves.toBeNull();
  });

  it.each(['paused', 'forwarding_pending', 'cancelled'])(
    'refuses a subscription in %s — taking a message nobody watches is worse than not answering',
    async (status) => {
      state.virtualNumberFindUnique.mockResolvedValue({
        ...ASSIGNED,
        subscription: { ...ASSIGNED.subscription, status },
      });
      await expect(resolveCallTarget(prisma, '+34910000001')).resolves.toBeNull();
    },
  );
});

describe('recordIncomingCall', () => {
  const TARGET = {
    subscriptionId: 'sub_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    virtualNumberId: 'vn_1',
    hasGreeting: true,
  };

  beforeEach(() => {
    state.callEventUpsert.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });
  });

  it('upserts on the CallSid so a Twilio retry does not create a second row', async () => {
    await recordIncomingCall(prisma, TARGET, { callSid: 'CA1', from: '+34600111222', to: '+34910000001' });
    const arg = state.callEventUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ twilioCallSid: 'CA1' });
    // Empty update: a retry carries the same facts, and rewriting
    // startedAt would corrupt the timestamp the reporting is built on.
    expect(arg.update).toEqual({});
  });

  it('stores a callable number and leaves the outcome pending', async () => {
    await recordIncomingCall(prisma, TARGET, { callSid: 'CA1', from: '+34600111222', to: '+34910000001' });
    const create = state.callEventUpsert.mock.calls[0][0].create;
    expect(create.fromNumber).toBe('+34600111222');
    expect(create.withheld).toBe(false);
    expect(create.outcome).toBe('pending');
  });

  it('marks a withheld call terminal immediately — there is nobody to call back', async () => {
    await recordIncomingCall(prisma, TARGET, { callSid: 'CA2', from: 'anonymous', to: '+34910000001' });
    const create = state.callEventUpsert.mock.calls[0][0].create;
    expect(create.withheld).toBe(true);
    expect(create.fromNumber).toBeNull();
    expect(create.outcome).toBe('withheld');
  });
});

describe('attachRecording', () => {
  it('404s a recording for a call we never saw', async () => {
    state.callEventFindUnique.mockResolvedValue(null);
    await expect(
      attachRecording(prisma, { callSid: 'CA_unknown', recordingSid: 'RE1', recordingUrl: 'u', durationSeconds: 5 }),
    ).resolves.toEqual({ ok: false, error: 'call_not_found' });
  });

  it('marks a call with audio as recorded', async () => {
    state.callEventFindUnique.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });
    state.callEventUpdate.mockResolvedValue({});
    await attachRecording(prisma, { callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'u', durationSeconds: 12 });
    expect(state.callEventUpdate.mock.calls[0][0].data.outcome).toBe('recorded');
  });

  it('marks a zero-length recording as no_message — a real outcome, not a failure', async () => {
    state.callEventFindUnique.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });
    state.callEventUpdate.mockResolvedValue({});
    await attachRecording(prisma, { callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'u', durationSeconds: 0 });
    expect(state.callEventUpdate.mock.calls[0][0].data.outcome).toBe('no_message');
  });

  it('never downgrades a withheld call, even if it somehow produced audio', async () => {
    state.callEventFindUnique.mockResolvedValue({ id: 'ce_1', outcome: 'withheld' });
    state.callEventUpdate.mockResolvedValue({});
    await attachRecording(prisma, { callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'u', durationSeconds: 30 });
    expect(state.callEventUpdate.mock.calls[0][0].data.outcome).toBe('withheld');
  });

  it('stores only the pointer, never the audio itself', async () => {
    state.callEventFindUnique.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });
    state.callEventUpdate.mockResolvedValue({});
    await attachRecording(prisma, { callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'https://api.twilio.com/x', durationSeconds: 9 });
    const { data } = state.callEventUpdate.mock.calls[0][0];
    expect(data.recordingSid).toBe('RE1');
    expect(data.recordingUrl).toBe('https://api.twilio.com/x');
    // Retention is kept at Twilio; nothing audio-shaped is persisted here.
    expect(Object.keys(data)).not.toContain('recordingAudio');
  });

  it('treats a duplicate re-delivery as success rather than an error', async () => {
    state.callEventFindUnique.mockResolvedValue({ id: 'ce_1', outcome: 'pending' });
    state.callEventUpdate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(
      attachRecording(prisma, { callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'u', durationSeconds: 5 }),
    ).resolves.toEqual({ ok: true, callEventId: 'ce_1' });
  });
});
