// =============================================================================
// KAIA-1165 / KAIA-14519 — unit tests for src/lib/wizard-review.ts
//
// Covers the operator review state machine:
//
//   approve / request_revision (KAIA-1165):
//     * approve flips activeForBot on the latest submitted version, writes
//       approve + activate audit rows, and deactivates any previous active
//       row (writing a deactivate audit row).
//     * request_revision requires a comment, writes one audit row, leaves
//       activeForBot alone.
//     * Errors: client_not_found, step_not_found, invalid_state_for_approve,
//       comment_required, comment_too_long.
//
//   Wizard state transitions (KAIA-14519):
//     * Approve the last mandatory step while state='in-progress' → flip
//       to 'ready' + fire one config_complete notify. Re-approve the same
//       step on the next request → no second transition, no second notify.
//     * request_revision on a mandatory step while state='live' → flip
//       to 'updating' + fire one config-updating notify. Non-mandatory
//       steps (Step 8 / Step 12) do NOT trip the transition.
//     * live never regresses to ready (terminal).
//     * Step 12 is ignored for the readiness check.
//
// The route handler (src/app/api/admin/portal/wizard/[clientId]/[step]/route.ts)
// is a thin wrapper around applyWizardReview; the Playwright smoke covers
// auth/serialization, so this file is the primary safety net.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MockTx {
  chatbotClient: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
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
  const makeTx = (): MockTx => ({
    chatbotClient: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
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
    // Post-commit (used by the notify path)
    operatorNotification: { upsert: vi.fn() },
  };
});

// Capture the most recent sendOperatorNotification invocation so the
// transition tests can assert on the kind + payload without depending on
// the operator-notify module surface.
const mockSend = vi.hoisted(() => ({
  sendOperatorNotification: vi.fn(),
  resolveOperatorRecipients: vi.fn(() => [{ email: 'ops@example.com' }]),
  utcDayKey: vi.fn(() => '2026-08-11'),
}));

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
    operatorNotification: {
      upsert: (...args: unknown[]) => mockState.operatorNotification.upsert(...(args as [])),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/operator-notify', () => ({
  sendOperatorNotification: (...args: unknown[]) =>
    mockSend.sendOperatorNotification(...(args as [])),
  resolveOperatorRecipients: (...args: unknown[]) =>
    mockSend.resolveOperatorRecipients(...(args as [])),
  utcDayKey: (...args: unknown[]) => mockSend.utcDayKey(...(args as [])),
  ALLOWED_KINDS: new Set([
    'stuck',
    'execution-failed',
    'escalation',
    'review-overdue-warning',
    'review-overdue-escalation',
  ]),
}));

import { applyWizardReview, getWizardStepReview, WizardReviewError } from '@/lib/wizard-review';

function resetAllMocks() {
  Object.values(mockState).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset();
  });
  mockState.tx.chatbotClient.findUnique.mockReset();
  mockState.tx.chatbotClient.updateMany.mockReset();
  mockState.tx.chatbotConfigStep.findFirst.mockReset();
  mockState.tx.chatbotConfigStep.findMany.mockReset();
  mockState.tx.chatbotConfigStep.update.mockReset();
  mockState.tx.chatbotConfigStepAudit.create.mockReset();
  mockState.tx.chatbotConfigStepAudit.createMany.mockReset();
  mockState.tx.chatbotConfigStepAudit.findMany.mockReset();
  mockState.operatorNotification.upsert.mockReset();
  mockSend.sendOperatorNotification.mockReset();
  mockSend.resolveOperatorRecipients.mockReset();
  mockSend.utcDayKey.mockReset();
}

beforeEach(() => {
  resetAllMocks();
  // $transaction runs the callback with our tx mock
  mockState.$transaction.mockImplementation((fn: (tx: MockTx) => unknown) => fn(mockState.tx));
  // Default recipients + day for every test.
  mockSend.resolveOperatorRecipients.mockReturnValue([{ email: 'ops@example.com' }]);
  mockSend.utcDayKey.mockReturnValue('2026-08-11');
  // Default Resend success → returns `{ ok: true, messageId: '...' }`
  mockSend.sendOperatorNotification.mockResolvedValue({ ok: true, messageId: 'res_msg_1' });
  // Default UPDATE returns 1 — the readiness / updating flip succeeded.
  mockState.tx.chatbotClient.updateMany.mockResolvedValue({ count: 1 });
  mockState.operatorNotification.upsert.mockResolvedValue({ id: 'opn_1' });
  // Default: no active rows in tx.findMany — readiness check sees the
  // full `REQUIRED_STEP_KEYS_FOR_READY` set as missing, so the legacy
  // (non-KAIA-14519) tests don't accidentally trip a transition.
  mockState.tx.chatbotConfigStep.findMany.mockResolvedValue([]);
});

const OPERATOR = { operatorId: 'op-1', email: 'ops@example.com' };

// Stand-in PrismaClient that has enough surface for both the in-tx
// helpers (chatbotClient/chatbotConfigStep/chatbotConfigStepAudit) AND
// the post-commit notify path (operatorNotification.upsert). The shape
// mirrors what the real prisma client exposes — typed as `never` via
// `as never` because the runtime is built from vi.fn() decorators.
function mockPrisma() {
  return {
    $transaction: mockState.$transaction,
    chatbotClient: mockState.tx.chatbotClient,
    chatbotConfigStep: mockState.tx.chatbotConfigStep,
    chatbotConfigStepAudit: mockState.tx.chatbotConfigStepAudit,
    operatorNotification: { upsert: mockState.operatorNotification.upsert },
  } as never;
}

describe('applyWizardReview — approve', () => {
  it('rejects with client_not_found when the client row is missing', async () => {
    mockState.tx.chatbotClient.findUnique.mockResolvedValue(null);
    await expect(
      applyWizardReview(
        // The mock prisma is a structural stand-in; the real call goes through
        // $transaction which we wired to call our handler with the mock tx.
        mockPrisma(),
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
        mockPrisma(),
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(WizardReviewError);
    try {
      await applyWizardReview(
        mockPrisma(),
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
        mockPrisma(),
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
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1', tenantId: 'tenant-1' }) // ensureClientExists
      .mockResolvedValueOnce({
        // loadClientForTransition
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: 'Acme Corp',
        email: 'ops@acme.com',
      });
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
    // Readiness: only Step 1 active so far → still missing.
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValue([{ stepKey: '1' }]);

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '1', action: 'approve', comment: 'Looks good' },
      OPERATOR,
    );

    expect(result.status).toBe('approved');
    expect(result.activeForBot).toBe(true);
    expect(result.deactivatedStepIds).toEqual([]);
    expect(result.transition.nextState).toBeNull();
    expect(mockState.tx.chatbotClient.updateMany).not.toHaveBeenCalled();
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
          tenantId: 'tenant-1',
          version: 1,
          actor: 'operator',
          actorId: OPERATOR.operatorId,
          action: 'approve',
          comment: 'Looks good',
        }),
        expect.objectContaining({
          stepId: 's1',
          tenantId: 'tenant-1',
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
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' }) // ensureClientExists
      .mockResolvedValueOnce({
        // loadClientForTransition (state != in-progress → no flip)
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: 'Acme Corp',
        email: 'ops@acme.com',
      });
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
      mockPrisma(),
      { clientId: 'c1', stepKey: '2', action: 'approve' },
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
        mockPrisma(),
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
        mockPrisma(),
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
      mockPrisma(),
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

// ---------------------------------------------------------------------------
// KAIA-14519 — wizard state transitions on the review edges.
// ---------------------------------------------------------------------------

describe('applyWizardReview — KAIA-14519 ready transition', () => {
  it('flips client to ready and fires config_complete when the last mandatory step approves', async () => {
    // The 12 mandatory stepKeys per wizard-catalog (Step 12 excluded as
    // v1.1-deferred). We simulate "Step 5 was the last one to need approval"
    // by returning all of them in the active set.
    const allMandatory = [
      '1', '2', '3', '4', '5', '6', '7', '9', '10', '11',
    ];
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' }) // ensureClientExists
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: 'Acme Corp',
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's5', version: 2, status: 'submitted' }) // latest
      .mockResolvedValueOnce(null); // no previous active
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValue(
      allMandatory.map((stepKey) => ({ stepKey })),
    );

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '5', action: 'approve' },
      OPERATOR,
    );

    // State flipped in the transaction via updateMany (not update).
    expect(mockState.tx.chatbotClient.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', state: 'in-progress' },
      data: { state: 'ready' },
    });
    expect(result.transition.nextState).toBe('ready');
    expect(result.transition.notifyFired).toBe(true);
    expect(result.transition.resendMessageId).toBe('res_msg_1');
    expect(result.transition.notifyError).toBeNull();
    // Notify was sent with the right kind + contains the client name.
    expect(mockSend.sendOperatorNotification).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.sendOperatorNotification.mock.calls[0][0];
    expect(sendArg.kind).toBe('config_complete');
    expect(sendArg.subject).toContain('Acme Corp');
    // The dedup row was upserted under (clientId, kind, day).
    expect(mockState.operatorNotification.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockState.operatorNotification.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({
      clientId_kind_day: { clientId: 'c1', kind: 'config_complete', day: '2026-08-11' },
    });
  });

  it('does not flip to ready when a mandatory step is still missing', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' }) // ensureClientExists
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's5', version: 2, status: 'submitted' })
      .mockResolvedValueOnce(null);
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    // Step 5 just got approved — Step 11 still missing.
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValue([
      { stepKey: '1' }, { stepKey: '2' }, { stepKey: '3' }, { stepKey: '4' }, { stepKey: '5' },
      { stepKey: '6' }, { stepKey: '7' }, { stepKey: '9' }, { stepKey: '10' },
    ]);

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '5', action: 'approve' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).not.toHaveBeenCalled();
    expect(result.transition.nextState).toBeNull();
    expect(mockSend.sendOperatorNotification).not.toHaveBeenCalled();
    expect(mockState.operatorNotification.upsert).not.toHaveBeenCalled();
  });

  it('ignores Step 12 in the readiness check (not in requiredForReady set)', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' }) // ensureClientExists
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's11', version: 1, status: 'submitted' }) // approve Step 11
      .mockResolvedValueOnce(null);
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's11',
      version: 1,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    // Step 11 just approved + the other 9 mandatory ones already active.
    // Note: no Step 12 in the active list → readiness still satisfied
    // because Step 12 is not in WIZARD_REQUIRED_STEP_NUMBERS.
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValue([
      { stepKey: '1' }, { stepKey: '2' }, { stepKey: '3' }, { stepKey: '4' }, { stepKey: '5' },
      { stepKey: '6' }, { stepKey: '7' }, { stepKey: '9' }, { stepKey: '10' }, { stepKey: '11' },
    ]);

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '11', action: 'approve' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', state: 'in-progress' },
      data: { state: 'ready' },
    });
    expect(result.transition.nextState).toBe('ready');
    expect(mockSend.sendOperatorNotification).toHaveBeenCalledTimes(1);
  });

  it('does not regress a ready or live client back to anything', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'ready',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'submitted' })
      .mockResolvedValueOnce(null);
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's1',
      version: 1,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    // Even if the active-set were full (which it shouldn't be since this
    // client was never 'in-progress'), the state guard is the real check.
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValue([
      { stepKey: '1' }, { stepKey: '2' }, { stepKey: '3' }, { stepKey: '4' }, { stepKey: '5' },
      { stepKey: '6' }, { stepKey: '7' }, { stepKey: '9' }, { stepKey: '10' }, { stepKey: '11' },
    ]);

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '1', action: 'approve' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).not.toHaveBeenCalled();
    expect(result.transition.nextState).toBeNull();
    expect(mockSend.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('re-approving the same already-approved step does not double-fire the notify (idempotent)', async () => {
    // Two approve calls on the same client. First call flips state to
    // 'ready' and fires notify. Second call: state is already 'ready',
    // so maybeTransitionToReady short-circuits and notify is NOT re-fired.
    mockState.tx.chatbotClient.findUnique
      // First call
      .mockResolvedValueOnce({ id: 'c1' }) // ensureClientExists
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'in-progress',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'submitted' })
      .mockResolvedValueOnce(null);
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's1',
      version: 1,
      status: 'approved',
      activeForBot: true,
      approvedByOperatorId: OPERATOR.operatorId,
      approvedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    // All 10 mandatory stepKeys already active → readiness passes.
    mockState.tx.chatbotConfigStep.findMany.mockResolvedValueOnce([
      { stepKey: '1' }, { stepKey: '2' }, { stepKey: '3' }, { stepKey: '4' }, { stepKey: '5' },
      { stepKey: '6' }, { stepKey: '7' }, { stepKey: '9' }, { stepKey: '10' }, { stepKey: '11' },
    ]);
    mockState.tx.chatbotClient.updateMany.mockResolvedValueOnce({ count: 1 });

    await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '1', action: 'approve' },
      OPERATOR,
    );
    expect(mockSend.sendOperatorNotification).toHaveBeenCalledTimes(1);

    // Second call — same client, same step. The state is already 'ready'
    // so maybeTransitionToReady short-circuits at the guard.
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'ready',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst.mockReset();
    mockState.tx.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'approved' }); // already approved

    await expect(
      applyWizardReview(
        mockPrisma(),
        { clientId: 'c1', stepKey: '1', action: 'approve' },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ error: { code: 'invalid_state_for_approve' } });
    // Notify still exactly 1 — second call never reached the transition.
    expect(mockSend.sendOperatorNotification).toHaveBeenCalledTimes(1);
  });
});

describe('applyWizardReview — KAIA-14519 updating transition', () => {
  it('flips client to updating when a mandatory step is sent back while live', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'live',
        name: 'Acme',
        companyName: 'Acme Corp',
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'submitted',
    });
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'needs_revision',
      activeForBot: true,
      approvedByOperatorId: null,
      approvedAt: null,
      revisionComment: 'Update the prices',
    });

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '5', action: 'request_revision', comment: 'Update the prices' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', state: 'live' },
      data: { state: 'updating' },
    });
    expect(result.transition.nextState).toBe('updating');
    expect(result.transition.notifyFired).toBe(true);
    expect(result.transition.resendMessageId).toBe('res_msg_1');
    const sendArg = mockSend.sendOperatorNotification.mock.calls[0][0];
    expect(sendArg.kind).toBe('config-updating');
    expect(sendArg.subject).toContain('Acme Corp');
    expect(mockState.operatorNotification.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not flip to updating when the client state is not "live"', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'in-progress', // not live
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'submitted',
    });
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's5',
      version: 2,
      status: 'needs_revision',
      activeForBot: true,
      approvedByOperatorId: null,
      approvedAt: null,
      revisionComment: 'Hmm',
    });

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '5', action: 'request_revision', comment: 'Hmm' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).not.toHaveBeenCalled();
    expect(result.transition.nextState).toBeNull();
    expect(mockSend.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('does not flip to updating for a non-mandatory step (Step 8)', async () => {
    mockState.tx.chatbotClient.findUnique
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        state: 'live',
        name: 'Acme',
        companyName: null,
        email: 'ops@acme.com',
      });
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({
      id: 's8',
      version: 1,
      status: 'submitted',
    });
    mockState.tx.chatbotConfigStep.update.mockResolvedValue({
      id: 's8',
      version: 1,
      status: 'needs_revision',
      activeForBot: true,
      approvedByOperatorId: null,
      approvedAt: null,
      revisionComment: 'Optional refinement',
    });

    const result = await applyWizardReview(
      mockPrisma(),
      { clientId: 'c1', stepKey: '8', action: 'request_revision', comment: 'Optional refinement' },
      OPERATOR,
    );

    expect(mockState.tx.chatbotClient.updateMany).not.toHaveBeenCalled();
    expect(result.transition.nextState).toBeNull();
    expect(mockSend.sendOperatorNotification).not.toHaveBeenCalled();
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
