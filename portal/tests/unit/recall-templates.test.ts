// =============================================================================
// WP-XX — unit tests for src/lib/recall-templates.ts: submitting recall's
// 6 WhatsApp templates to a client's WABA.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ createMessageTemplate: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { submitAllRecallTemplates, RECALL_TEMPLATE_DEFINITIONS } from '@/lib/recall-templates';

beforeEach(() => {
  mockState.createMessageTemplate.mockReset();
  mockState.logError.mockReset();
});

describe('RECALL_TEMPLATE_DEFINITIONS', () => {
  it('defines exactly the 6 templates the product actually sends, all Spanish UTILITY', () => {
    expect(RECALL_TEMPLATE_DEFINITIONS).toHaveLength(6);
    const names = RECALL_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      'recall_caller_open',
      'recall_caller_closed',
      'recall_owner_message',
      'recall_daily_digest',
      'recall_digest_clarify',
      'recall_monthly_report',
    ]);
    for (const def of RECALL_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
      expect(def.category).toBe('UTILITY');
    }
  });

  it('gives every {{n}} placeholder in the body text a matching example', () => {
    for (const def of RECALL_TEMPLATE_DEFINITIONS) {
      const placeholders = def.bodyText.match(/\{\{\d+\}\}/g) ?? [];
      expect(def.bodyExamples).toHaveLength(placeholders.length);
    }
  });
});

describe('submitAllRecallTemplates', () => {
  it('submits all 6 templates to the given WABA', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(6);
    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const call of mockState.createMessageTemplate.mock.calls) {
      expect(call[0]).toBe('token');
      expect(call[1]).toBe('waba_1');
    }
  });

  it('one rejected template does not stop the others from being submitted', async () => {
    mockState.createMessageTemplate.mockImplementation((_token, _waba, spec) => {
      if (spec.name === 'recall_caller_closed') {
        return Promise.resolve({ ok: false, error: 'invalid wording' });
      }
      return Promise.resolve({ ok: true, data: { status: 'PENDING' } });
    });

    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(6);
    const failed = outcomes.find((o) => o.name === 'recall_caller_closed');
    expect(failed).toMatchObject({ ok: false, error: 'invalid wording' });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.submit_failed',
      expect.any(Error),
      expect.objectContaining({ wabaId: 'waba_1', template: 'recall_caller_closed' }),
      'warn',
    );
  });

  it('never throws — a network failure on every call still returns 6 outcomes', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'network down' });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');
    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });
});
