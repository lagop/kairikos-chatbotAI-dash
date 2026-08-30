// =============================================================================
// WP-XX — unit tests for src/lib/recall-templates.ts: submitting recall's
// 6 WhatsApp templates to a client's WABA.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ createMessageTemplate: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  submitAllRecallTemplates,
  advanceSubscriptionsWithApprovedTemplates,
  RECALL_TEMPLATE_DEFINITIONS,
} from '@/lib/recall-templates';

const state = {
  recallSubscriptionFindMany: vi.fn(),
  recallSubscriptionUpdate: vi.fn(),
  whatsappTemplateCount: vi.fn(),
  recallSubscriptionAuditCreate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findMany: (...a: unknown[]) => state.recallSubscriptionFindMany(...a),
    update: (...a: unknown[]) => state.recallSubscriptionUpdate(...a),
  },
  whatsappTemplate: {
    count: (...a: unknown[]) => state.whatsappTemplateCount(...a),
  },
  recallSubscriptionAudit: {
    create: (...a: unknown[]) => state.recallSubscriptionAuditCreate(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  mockState.createMessageTemplate.mockReset();
  mockState.logError.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
  state.recallSubscriptionFindMany.mockResolvedValue([]);
  state.whatsappTemplateCount.mockResolvedValue(0);
  state.recallSubscriptionUpdate.mockResolvedValue({ status: 'templates_approved' });
  state.recallSubscriptionAuditCreate.mockResolvedValue({});
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

describe('advanceSubscriptionsWithApprovedTemplates', () => {
  const SUB = { id: 'sub_1', clientId: 'client_1', status: 'number_assigned', metaConnectionId: 'conn_1' };

  it('scopes the candidate query to number_assigned subscriptions with a bound connection', async () => {
    await advanceSubscriptionsWithApprovedTemplates(prisma);
    expect(state.recallSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'number_assigned', metaConnectionId: { not: null } },
      }),
    );
  });

  it('advances to templates_approved once all 6 required templates are APPROVED', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([SUB]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma, { now: new Date('2026-09-01T00:00:00Z') });

    expect(result).toEqual({ advanced: 1 });
    expect(state.whatsappTemplateCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ connectionId: 'conn_1', status: 'APPROVED' }),
      }),
    );
    expect(state.recallSubscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: { status: 'templates_approved', templatesApprovedAt: new Date('2026-09-01T00:00:00Z') },
      select: { status: true },
    });
    expect(state.recallSubscriptionAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId: 'sub_1',
          action: 'templates_approved',
          actorType: 'system',
        }),
      }),
    );
  });

  it('does not advance when only some of the 6 required templates are approved', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([SUB]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length - 1);

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 0 });
    expect(state.recallSubscriptionUpdate).not.toHaveBeenCalled();
  });

  it('one subscription failing its audit write does not stop the others from advancing', async () => {
    const sub2 = { ...SUB, id: 'sub_2', clientId: 'client_2' };
    state.recallSubscriptionFindMany.mockResolvedValue([SUB, sub2]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);
    state.recallSubscriptionAuditCreate.mockRejectedValueOnce(new Error('db down'));

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 2 });
    expect(state.recallSubscriptionUpdate).toHaveBeenCalledTimes(2);
  });
});
