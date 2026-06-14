// =============================================================================
// KAIA-1165 — unit tests for src/lib/wizard-review.ts
//
// Covers the state-machine: approve (flips activeForBot, writes approve +
// activate + deactivate audit rows), request_revision (requires comment,
// writes one audit row, does not touch activeForBot), and the documented
// error paths (client_not_found, step_not_found, invalid_state_for_approve,
// comment_required, comment_too_long).
//
// The route handler (src/app/api/admin/portal/wizard/[clientId]/[step]/route.ts)
// is a thin wrapper around applyWizardReview + getWizardStepReview; the
// Playwright smoke (when added) covers auth/serialization, not the state
// machine, so this file is the primary safety net.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MockTx {
  chatbotClient: { findUnique: ReturnType<typeof vi.fn> };
  chatbotConfigStep: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  chatbotConfigStepAudit: {
    create: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
}

const mockState = vi.hoisted(() => {
  const makeTx = () => ({
    chatbotClient: { findUnique: vi.fn() },
    chatbotConfigStep: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    chatbotConfigStepAudit: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
  });
  return {
    tx: makeTx(),
    $transaction: vi.fn(),
    // Read-only helpers (used by getWizardStepReview)
    chatbotClient: { findUnique: vi.fn() },
    chatbotConfigStep: { findMany: vi.fn() },
    chatbotConfigStepAudit: { findMany: vi.fn() },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: MockTx) => unknown) => mockState.$transaction(fn),
    chatbotClient: {
      findUnique: (...args: unknown[]) => mockState.chatbotClient.findUnique(...(args as [])),
    },
    chatbotConfigStep: {
      findMany: (...args: unknown[]) => mockState.chatbotConfigStep.findMany(...(args as [])),
    },
    chatbotConfigStepAudit: {
      findMany: (...args: unknown[]) => mockState.chatbotConfigStepAudit.findMany(...(args as [])),
    },
  },
  isDatabaseConfigured: true,
}));

import { applyWizardReview, getWizardStepReview, WizardReviewError } from '@/lib/wizard-review';

function resetAllMocks() {
  Object.values(mockState).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset();
  });
  mockState.tx.chatbotClient.findUnique.mockReset();
  mockState.tx.chatbotConfigStep.findFirst.mockReset();
  mockState.tx.chatbotConfigStep.findMany.mockReset();
  mockState.tx.chatbotConfigStep.update.mockReset();
  mockState.tx.chatbotConfigStepAudit.create.mockReset();
  mockState.tx.chatbotConfigStepAudit.createMany.mockReset();
  mockState.tx.chatbotConfigStepAudit.findMany.mockReset();
}

beforeEach(() => {
  resetAllMocks();
  // $transaction runs the callback with our tx mock
  mockState.$transaction.mockImplementation((fn: (tx: MockTx) => unknown) => fn(mockState.tx));
});

const OPERATOR = { operatorId: 'op-1', email: 'ops@example.com' };

describe('applyWizardReview — approve', () => {
  it('rejects with client_not_found when the client row is missing', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue(null);
    await expect(
      applyWizardReview(
        // The mock prisma is a structural stand-in; the real call goes through
        // $transaction which we wired to call our handler with the mock tx.
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ error: { code: 'client_not_found' } });
  });

  it('rejects with step_not_found when no version exists', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue(null);
    await expect(
      applyWizardReview(
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(WizardReviewError);
    try {
      await applyWizardReview(
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      );
    } catch (e) {
      expect((e as WizardReviewError).error).toEqual({ code: 'step_not_found' });
    }
  });

  it('rejects with invalid_state_for_approve when latest is not submitted', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ id: 's1', version: 2, status: 'draft' });
    try {
      await applyWizardReview(
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardReviewError).error).toEqual({ code: 'invalid_state_for_approve' });
    }
    expect(mockState.tx.chatbotConfigStep.update).not.toHaveBeenCalled();
    expect(mockState.tx.chatbotConfigStepAudit.createMany).not.toHaveBeenCalled();
  });

  it('approves when latest is submitted and no previous active row exists', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'submitted' }) // latest
      .mockResolvedValueOnce(null); // no previous active
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's1',
      version: 1,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });

    const result = await applyWizardReview(
      { $transaction: mockState.$transaction } as never,
      { clientId: 'c1', stepKey: '1', action: 'approve', comment: 'Looks good' },
      OPERATOR,
    );

    expect(result.status).toBe('approved');
    expect(result.activeForBot).toBe(true);
    expect(result.deactivatedStepIds).toEqual([]);
    expect(mockState.tx.chatbotConfigStep.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        status: 'approved',
        activeForBot: true,
        approvedAt: expect.any(Date),
        approvedByOperatorId: OPERATOR.operatorId,
      },
      select: {
        id: true,
        version: true,
        status: true,
        activeForBot: true,
        approvedByOperatorId: true,
        approvedAt: true,
      },
    });
    expect(mockState.tx.chatbotConfigStepAudit.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stepId: 's1',
          version: 1,
          actor: 'operator',
          actorId: OPERATOR.operatorId,
          action: 'approve',
          comment: 'Looks good',
        }),
        expect.objectContaining({
          stepId: 's1',
          version: 1,
          actor: 'system',
          actorId: null,
          action: 'activate',
          comment: null,
        }),
      ],
    });
  });

  it('deactivates the previous active row and writes a deactivate audit row', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's2', version: 2, status: 'submitted' }) // latest
      .mockResolvedValueOnce({ id: 's1', version: 1 }); // previous active
    mockState.tx.chatbotConfigStep.update
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'approved' }) // deactivate s1
      .mockResolvedValueOnce({
        // approve s2
        id: 's2',
        version: 2,
        status: 'approved',
        activeForBot: true,
        approvedByOperatorId: OPERATOR.operatorId,
        approvedAt: new Date('2026-06-13T10:00:00.000Z'),
      });
    mockState.tx.chatbotConfigStepAudit.create.mockResolvedValue({ id: 'audit_x' });

    const result = await applyWizardReview(
      { $transaction: mockState.$transaction } as never,
      { clientId: 'c1', stepKey: '1', action: 'approve' },
      OPERATOR,
    );

    expect(result.deactivatedStepIds).toEqual(['s1']);
    expect(mockState.tx.chatbotConfigStep.update).toHaveBeenCalledTimes(2);
    expect(mockState.tx.chatbotConfigStep.update).toHaveBeenNthCalledWith(1, {
      where: { id: 's1' },
      data: { activeForBot: false },
    });
    expect(mockState.tx.chatbotConfigStepAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stepId: 's1',
        version: 1,
        actor: 'system',
        action: 'deactivate',
      }),
    });
  });
});

describe('applyWizardReview — request_revision', () => {
  it('rejects with comment_required when no comment is supplied', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ id: 's1', version: 1, status: 'submitted' });
    try {
      await applyWizardReview(
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'request_revision', comment: '   ' },
        OPERATOR,
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardReviewError).error).toEqual({ code: 'comment_required' });
    }
  });

  it('rejects with comment_too_long when comment exceeds the cap', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ id: 's1', version: 1, status: 'submitted' });
    try {
      await applyWizardReview(
        { $transaction: mockState.$transaction } as never,
        { clientId: 'c1', stepKey: '1', action: 'request_revision', comment: 'x'.repeat(2001) },
        OPERATOR,
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardReviewError).error).toEqual({ code: 'comment_too_long' });
    }
  });

  it('flips status to needs_revision and writes one audit row', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue({ id: 'c1' });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ id: 's1', version: 1, status: 'submitted' });
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's1',
      version: 1,
      status: 'needs_revision',
      activeForBot: true,
      approvedByOperatorId: null,
      approvedAt: null,
      revisionComment: 'Please add the company logo',
    });

    const result = await applyWizardReview(
      { $transaction: mockState.$transaction } as never,
      { clientId: 'c1', stepKey: '1', action: 'request_revision', comment: 'Please add the company logo' },
      OPERATOR,
    );

    expect(result.status).toBe('needs_revision');
    expect(result.activeForBot).toBe(true);
    expect(result.revisionComment).toBe('Please add the company logo');
    expect(result.deactivatedStepIds).toEqual([]);
    expect(mockState.tx.chatbotConfigStep.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'needs_revision', revisionComment: 'Please add the company logo' },
      select: expect.any(Object),
    });
    expect(mockState.tx.chatbotConfigStepAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stepId: 's1',
        version: 1,
        actor: 'operator',
        actorId: OPERATOR.operatorId,
        action: 'request_revision',
        comment: 'Please add the company logo',
      }),
    });
  });
});

describe('getWizardStepReview', () => {
  it('returns null when the client does not exist', async () => {
    mockState.chatbotClient.findUnique.mockResolvedValue(null);
    const out = await getWizardStepReview(
      { chatbotClient: mockState.chatbotClient } as never,
      'c1',
      '1',
    );
    expect(out).toBeNull();
  });

  it('returns null when the client exists but no version has been saved', async () => {
    mockState.chatbotClient.findUnique.mockResolvedValue({ id: 'c1', name: 'Acme' });
    mockState.chatbotConfigStep.findMany.mockResolvedValue([]);
    const out = await getWizardStepReview(
      {
        chatbotClient: mockState.chatbotClient,
        chatbotConfigStep: mockState.chatbotConfigStep,
        chatbotConfigStepAudit: mockState.chatbotConfigStepAudit,
      } as never,
      'c1',
      '1',
    );
    expect(out).toBeNull();
  });

  it('returns client + versions + audit when present', async () => {
    mockState.chatbotClient.findUnique.mockResolvedValue({ id: 'c1', name: 'Acme' });
    mockState.chatbotConfigStep.findMany.mockResolvedValue([
      { id: 's1', version: 1, status: 'approved' },
    ]);
    mockState.chatbotConfigStepAudit.findMany.mockResolvedValue([
      { id: 'a1', stepId: 's1', version: 1, actor: 'operator', action: 'approve' },
    ]);
    const out = await getWizardStepReview(
      {
        chatbotClient: mockState.chatbotClient,
        chatbotConfigStep: mockState.chatbotConfigStep,
        chatbotConfigStepAudit: mockState.chatbotConfigStepAudit,
      } as never,
      'c1',
      '1',
    );
    expect(out?.versions).toHaveLength(1);
    expect(out?.auditLogs).toHaveLength(1);
  });
});
