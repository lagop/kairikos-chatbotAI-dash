// =============================================================================
// Canales — unit tests for src/lib/whatsapp-api.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  subscribeWaba,
  unsubscribeWaba,
  sendMessage,
  sendTemplate,
  getPhoneNumberInfo,
  getPhoneNumbersForWaba,
  syncSmbAppState,
  listMessageTemplates,
  createMessageTemplate,
  isRetryableWhatsAppError,
  WHATSAPP_ERROR,
} from '@/lib/whatsapp-api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  delete process.env.META_GRAPH_API_VERSION;
});

describe('subscribeWaba', () => {
  it('POSTs to /{wabaId}/subscribed_apps with the access token as a query param', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await subscribeWaba('token-abc', 'waba_123');
    expect(result).toEqual({ ok: true, data: { success: true } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/waba_123/subscribed_apps');
    expect(url).toContain('access_token=token-abc');
    expect(init.method).toBe('POST');
  });

  it('returns an error result when Meta rejects the subscription', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid OAuth access token' } }));
    const result = await subscribeWaba('bad-token', 'waba_123');
    expect(result).toMatchObject({ ok: false, error: 'Invalid OAuth access token' });
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await subscribeWaba('token', 'waba_123');
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('unsubscribeWaba', () => {
  it('DELETEs /{wabaId}/subscribed_apps', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await unsubscribeWaba('token-abc', 'waba_123');
    expect(result).toEqual({ ok: true, data: { success: true } });
    const [, init] = mockState.fetch.mock.calls[0];
    expect(init.method).toBe('DELETE');
  });
});

describe('sendMessage', () => {
  it('sends a well-formed WhatsApp Cloud API text message payload', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.abc' }] }));
    const result = await sendMessage('token-abc', 'phone_1', '34600000000', 'Hola, ¿en qué puedo ayudarte?');
    expect(result).toEqual({ ok: true, data: { messages: [{ id: 'wamid.abc' }] } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/phone_1/messages');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '34600000000',
      type: 'text',
      text: { body: 'Hola, ¿en qué puedo ayudarte?' },
    });
  });

  it('returns an error result when Meta rejects the send', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: '24 hour window expired' } }));
    const result = await sendMessage('token', 'phone_1', '34600000000', 'hola');
    expect(result).toMatchObject({ ok: false, error: '24 hour window expired' });
  });
});

// =============================================================================
// WP-XX — the additions that make this product possible: Meta's numeric
// error codes (which decide retry-or-give-up), templates (the only way to
// message someone outside the 24h window), and GET support.
// =============================================================================

describe('Meta error codes', () => {
  it('propagates the numeric code and subcode, not just the prose', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse(
        { error: { message: 'Re-engagement message', code: 131047, error_subcode: 2018278 } },
        false,
        400,
      ),
    );
    const result = await sendMessage('token', 'phone_1', '34600000000', 'hola');

    // The prose alone cannot distinguish a transient outage from a
    // permanently-paused template; the code can.
    expect(result).toEqual({
      ok: false,
      error: 'Re-engagement message',
      code: 131047,
      subcode: 2018278,
      status: 400,
    });
  });

  it('falls back to an http-shaped error when Meta returns no body', async () => {
    mockState.fetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => null } as unknown as Response);
    const result = await sendMessage('token', 'phone_1', '34600000000', 'hola');
    expect(result).toMatchObject({ ok: false, error: 'whatsapp_api_http_502', status: 502 });
  });
});

describe('isRetryableWhatsAppError', () => {
  it('refuses to retry what will never succeed', () => {
    // Our own bug: the same call will fail the same way forever.
    expect(isRetryableWhatsAppError({ code: WHATSAPP_ERROR.TEMPLATE_PARAM_MISMATCH })).toBe(false);
    // Meta paused it for quality; retrying makes the quality score worse.
    expect(isRetryableWhatsAppError({ code: WHATSAPP_ERROR.TEMPLATE_PAUSED })).toBe(false);
    // The number has no WhatsApp — this is the SMS-fallback signal.
    expect(isRetryableWhatsAppError({ code: WHATSAPP_ERROR.UNDELIVERABLE })).toBe(false);
  });

  it('retries what might', () => {
    expect(isRetryableWhatsAppError({ code: WHATSAPP_ERROR.PAIR_RATE_LIMIT })).toBe(true);
    expect(isRetryableWhatsAppError({ status: 500 })).toBe(true);
    expect(isRetryableWhatsAppError({ status: 429 })).toBe(true);
    // No status at all means the request never reached Meta.
    expect(isRetryableWhatsAppError({})).toBe(true);
  });
});

describe('sendTemplate', () => {
  it('sends a template rather than free text — the only thing that works outside the 24h window', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.1' }] }));
    await sendTemplate('token', 'phone_1', '34600000000', {
      name: 'recall_missed_call',
      languageCode: 'es',
    });

    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body as string);
    expect(body.type).toBe('template');
    expect(body.template).toEqual({ name: 'recall_missed_call', language: { code: 'es' } });
    // No components key at all when there are no placeholders — Meta
    // rejects an empty components array.
    expect(body.template.components).toBeUndefined();
  });

  it('maps body params to positional placeholders in order', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.1' }] }));
    await sendTemplate('token', 'phone_1', '34600000000', {
      name: 'recall_missed_call',
      languageCode: 'es',
      bodyParams: ['Juan', 'Fontanería Aurora'],
    });

    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body as string);
    expect(body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Juan' },
          { type: 'text', text: 'Fontanería Aurora' },
        ],
      },
    ]);
  });
});

describe('getPhoneNumberInfo', () => {
  it('GETs the number Meta actually has — which the portal never stored before', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ id: 'phone_1', display_phone_number: '+34 600 11 22 33', quality_rating: 'GREEN' }),
    );
    const result = await getPhoneNumberInfo('token', 'phone_1');

    expect(mockState.fetch.mock.calls[0][1].method).toBe('GET');
    expect(String(mockState.fetch.mock.calls[0][0])).toContain('display_phone_number');
    expect(result).toEqual({
      ok: true,
      data: { id: 'phone_1', display_phone_number: '+34 600 11 22 33', quality_rating: 'GREEN' },
    });
  });

  it('requests platform_type — how a coexistence connection is told apart from a plain Cloud API one', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 'phone_1', platform_type: 'CLOUD_API' }));
    await getPhoneNumberInfo('token', 'phone_1');
    expect(String(mockState.fetch.mock.calls[0][0])).toContain('platform_type');
  });
});

describe('getPhoneNumbersForWaba', () => {
  it('GETs the numbers on a WABA — coexistence FINISH events never carry a phone_number_id', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'phone_9', display_phone_number: '+34 611 22 33 44' }] }),
    );
    const result = await getPhoneNumbersForWaba('token', 'waba_9');

    expect(mockState.fetch.mock.calls[0][1].method).toBe('GET');
    const url = String(mockState.fetch.mock.calls[0][0]);
    expect(url).toContain('/waba_9/phone_numbers');
    expect(result).toEqual({
      ok: true,
      data: { data: [{ id: 'phone_9', display_phone_number: '+34 611 22 33 44' }] },
    });
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('down'));
    const result = await getPhoneNumbersForWaba('token', 'waba_9');
    expect(result.ok).toBe(false);
  });
});

describe('syncSmbAppState', () => {
  it('POSTs the coexistence contact/history sync kickoff', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await syncSmbAppState('token', 'phone_9');

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toContain('/phone_9/smb_app_data');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' });
    expect(result).toEqual({ ok: true, data: { success: true } });
  });

  it('returns an error result (never throws) when Meta rejects it', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'not eligible' } }, false, 400));
    const result = await syncSmbAppState('token', 'phone_9');
    expect(result).toMatchObject({ ok: false });
  });
});

describe('listMessageTemplates', () => {
  it('GETs the WABA template list with review status and rejection reason', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 't1', name: 'recall_missed_call', language: 'es', status: 'APPROVED' }] }),
    );
    const result = await listMessageTemplates('token', 'waba_1');

    const url = String(mockState.fetch.mock.calls[0][0]);
    expect(mockState.fetch.mock.calls[0][1].method).toBe('GET');
    expect(url).toContain('/waba_1/message_templates');
    expect(url).toContain('rejected_reason');
    expect(result.ok).toBe(true);
  });
});

describe('createMessageTemplate', () => {
  it('POSTs a single-BODY-component template with the example filled from bodyExamples', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 'tmpl_1', status: 'PENDING', category: 'UTILITY' }));
    const result = await createMessageTemplate('token', 'waba_1', {
      name: 'recall_caller_open',
      languageCode: 'es',
      category: 'UTILITY',
      bodyText: 'Hola, soy el asistente de {{1}}.',
      bodyExamples: ['Peluquería Aurora'],
    });

    const url = String(mockState.fetch.mock.calls[0][0]);
    expect(mockState.fetch.mock.calls[0][1].method).toBe('POST');
    expect(url).toContain('/waba_1/message_templates');
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body as string);
    expect(body).toEqual({
      name: 'recall_caller_open',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hola, soy el asistente de {{1}}.',
          example: { body_text: [['Peluquería Aurora']] },
        },
      ],
    });
    expect(result).toEqual({ ok: true, data: { id: 'tmpl_1', status: 'PENDING', category: 'UTILITY' } });
  });

  it('omits the example entirely for a template with no placeholders, rather than sending an empty array', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 'tmpl_2', status: 'PENDING' }));
    await createMessageTemplate('token', 'waba_1', {
      name: 'recall_no_vars',
      languageCode: 'es',
      category: 'UTILITY',
      bodyText: 'Texto fijo sin variables.',
      bodyExamples: [],
    });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body as string);
    expect(body.components[0]).toEqual({ type: 'BODY', text: 'Texto fijo sin variables.' });
  });

  it('surfaces a rejected submission (e.g. already exists, or bad wording) as ok:false without throwing', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'A template with this name already exists', code: 100 } }, false, 400),
    );
    const result = await createMessageTemplate('token', 'waba_1', {
      name: 'recall_caller_open',
      languageCode: 'es',
      category: 'UTILITY',
      bodyText: 'Hola, soy el asistente de {{1}}.',
      bodyExamples: ['Peluquería Aurora'],
    });
    expect(result).toEqual({
      ok: false,
      error: 'A template with this name already exists',
      code: 100,
      subcode: undefined,
      status: 400,
    });
  });

  it('network failure never throws — logged and returned as ok:false', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('down'));
    const result = await createMessageTemplate('token', 'waba_1', {
      name: 'recall_caller_open',
      languageCode: 'es',
      category: 'UTILITY',
      bodyText: 'Hola, soy el asistente de {{1}}.',
      bodyExamples: ['Peluquería Aurora'],
    });
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
