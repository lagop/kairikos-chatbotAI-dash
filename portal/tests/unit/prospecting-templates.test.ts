// =============================================================================
// Unit tests for src/lib/prospecting-templates.ts — the 3 MARKETING
// templates for "Prospección con IA" cold outreach, submitted to Meta.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  createMessageTemplate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
}));

vi.mock('@/lib/prospecting-contact', () => ({
  PROSPECTING_TEMPLATES: {
    firstContact: { name: 'prospecting_first_contact', languageCode: 'es' },
    followUp1: { name: 'prospecting_follow_up_1', languageCode: 'es' },
    followUp2: { name: 'prospecting_follow_up_2', languageCode: 'es' },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { PROSPECTING_TEMPLATE_DEFINITIONS, submitAllProspectingTemplates } from '@/lib/prospecting-templates';

beforeEach(() => {
  mockState.createMessageTemplate.mockReset();
  mockState.logError.mockReset();
});

describe('PROSPECTING_TEMPLATE_DEFINITIONS', () => {
  it('defines exactly the 3 templates the product actually sends, all Spanish MARKETING — not UTILITY, this is cold outreach with no existing relationship', () => {
    expect(PROSPECTING_TEMPLATE_DEFINITIONS).toHaveLength(3);
    const names = PROSPECTING_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['prospecting_first_contact', 'prospecting_follow_up_1', 'prospecting_follow_up_2']);
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
      expect(def.category).toBe('MARKETING');
    }
  });

  it('gives every UNIQUE {{n}} placeholder a matching example', () => {
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      const uniquePlaceholders = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.bodyExamples).toHaveLength(uniquePlaceholders.size);
    }
  });

  it('never ends on a variable — the Meta rejection (error_subcode 2388299) already hit twice drafting recall\'s templates', () => {
    for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
      expect(def.bodyText.trim().endsWith('}}')).toBe(false);
    }
  });

  it('the two follow-ups offer an explicit way to stop hearing from us — no quick-reply button exists yet, so this is the content substitute', () => {
    const followUp1 = PROSPECTING_TEMPLATE_DEFINITIONS.find((t) => t.name === 'prospecting_follow_up_1');
    expect(followUp1?.bodyText).toContain('no volvemos a escribirte');
  });
});

describe('submitAllProspectingTemplates', () => {
  it('submits all 3 templates to the given WABA', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(3);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const call of mockState.createMessageTemplate.mock.calls) {
      expect(call[0]).toBe('token');
      expect(call[1]).toBe('waba_1');
      expect(call[2].category).toBe('MARKETING');
    }
  });

  it('one rejected template does not stop the others from being submitted', async () => {
    mockState.createMessageTemplate.mockImplementation((_token, _waba, spec) => {
      if (spec.name === 'prospecting_follow_up_2') {
        return Promise.resolve({ ok: false, error: 'invalid wording' });
      }
      return Promise.resolve({ ok: true, data: { status: 'PENDING' } });
    });

    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');

    const failed = outcomes.find((o) => o.name === 'prospecting_follow_up_2');
    expect(failed).toMatchObject({ ok: false, error: 'invalid wording' });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    expect(mockState.logError).toHaveBeenCalledWith(
      'prospecting_templates.submit_failed',
      expect.any(Error),
      expect.objectContaining({ wabaId: 'waba_1', template: 'prospecting_follow_up_2' }),
      'warn',
    );
  });

  it('never throws — a network failure on every call still returns 3 outcomes', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'network down' });
    const outcomes = await submitAllProspectingTemplates('token', 'waba_1');
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });
});
