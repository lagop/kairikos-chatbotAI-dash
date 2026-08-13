// =============================================================================
// KAIA-1164 — unit tests for src/lib/wizard-client.ts
//
// Pure tests for the read + write helpers: version increment, status
// enforcement, stepKey allowlist, audit row creation. The route handler
// adds auth + serialization, which the Playwright smoke covers.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MockTx {
  chatbotConfigStep: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  chatbotConfigStepAudit: { create: ReturnType<typeof vi.fn> };
  chatbotClient: { findUnique: ReturnType<typeof vi.fn> };
}

const mockState = vi.hoisted(() => {
  const makeTx = () => ({
    chatbotConfigStep: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    chatbotConfigStepAudit: { create: vi.fn() },
    // WP-09 — saveWizardStep looks up the client's tenantId to stamp onto
    // the new ChatbotConfigStep/ChatbotConfigStepAudit rows.
    chatbotClient: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }) },
  });
  return {
    tx: makeTx(),
    $transaction: vi.fn(),
    // Read-only helpers (used by readWizardStep)
    chatbotConfigStep: { findFirst: vi.fn() },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: MockTx) => unknown) => mockState.$transaction(fn),
    chatbotConfigStep: {
      findFirst: (...args: unknown[]) => mockState.chatbotConfigStep.findFirst(...(args as [])),
    },
  },
  isDatabaseConfigured: true,
}));

import {
  readWizardStep,
  saveWizardStep,
  WizardClientError,
} from '@/lib/wizard-client';

beforeEach(() => {
  Object.values(mockState).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset();
  });
  mockState.tx.chatbotConfigStep.findFirst.mockReset();
  mockState.tx.chatbotConfigStep.create.mockReset();
  mockState.tx.chatbotConfigStepAudit.create.mockReset();
  mockState.tx.chatbotClient.findUnique.mockReset().mockResolvedValue({ tenantId: 'tenant-1' });
  mockState.$transaction.mockImplementation((fn: (tx: MockTx) => unknown) => fn(mockState.tx));
});

const CTX = { clientId: 'client-1', email: 'client@example.com' };

describe('saveWizardStep', () => {
  it('rejects with invalid_step_key when stepKey is not in the allowlist', async () => {
    try {
      await saveWizardStep(
        { $transaction: mockState.$transaction } as never,
        CTX,
        { stepKey: 'bogus', data: { x: 1 }, status: 'draft' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardClientError).error).toEqual({ code: 'invalid_step_key' });
    }
  });

  it('rejects with invalid_data when data is not a JSON object', async () => {
    try {
      await saveWizardStep(
        { $transaction: mockState.$transaction } as never,
        CTX,
        { stepKey: '1', data: null as unknown as Record<string, unknown>, status: 'draft' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardClientError).error).toEqual({ code: 'invalid_data' });
    }
  });

  it('rejects with invalid_data when data is an array', async () => {
    try {
      await saveWizardStep(
        { $transaction: mockState.$transaction } as never,
        CTX,
        { stepKey: '1', data: [] as unknown as Record<string, unknown>, status: 'draft' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardClientError).error).toEqual({ code: 'invalid_data' });
    }
  });

  it('creates a version=1 row on the first save (autosave)', async () => {
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue(null);
    mockState.tx.chatbotConfigStep.create.mockResolvedValue({
      id: 's1',
      version: 1,
      status: 'draft',
    });
    const result = await saveWizardStep(
      { $transaction: mockState.$transaction } as never,
      CTX,
      { stepKey: '1', data: { business_name: 'Acme' }, status: 'draft' },
    );
    expect(result.version).toBe(1);
    expect(result.status).toBe('draft');
    expect(mockState.tx.chatbotConfigStep.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: 'client-1',
        stepKey: '1',
        version: 1,
        status: 'draft',
        payload: { business_name: 'Acme' },
        submittedAt: null,
      }),
      select: { id: true, version: true, status: true },
    });
    expect(mockState.tx.chatbotConfigStepAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: 'client',
        actorId: CTX.email,
        action: 'edit',
        version: 1,
      }),
    });
  });

  it('increments version on subsequent saves', async () => {
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ version: 3 });
    mockState.tx.chatbotConfigStep.create.mockResolvedValue({
      id: 's4',
      version: 4,
      status: 'draft',
    });
    const result = await saveWizardStep(
      { $transaction: mockState.$transaction } as never,
      CTX,
      { stepKey: '1', data: { x: 1 }, status: 'draft' },
    );
    expect(result.version).toBe(4);
  });

  it('sets submittedAt and writes a "submit" audit row on status=submitted', async () => {
    mockState.tx.chatbotConfigStep.findFirst.mockResolvedValue({ version: 1 });
    mockState.tx.chatbotConfigStep.create.mockResolvedValue({
      id: 's2',
      version: 2,
      status: 'submitted',
    });
    const result = await saveWizardStep(
      { $transaction: mockState.$transaction } as never,
      CTX,
      { stepKey: '1', data: { x: 1 }, status: 'submitted' },
    );
    expect(result.status).toBe('submitted');
    expect(mockState.tx.chatbotConfigStep.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'submitted',
        submittedAt: expect.any(Date),
      }),
      select: expect.any(Object),
    });
    expect(mockState.tx.chatbotConfigStepAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'submit',
        version: 2,
      }),
    });
  });
});

describe('readWizardStep', () => {
  it('rejects invalid stepKey with invalid_step_key', async () => {
    try {
      await readWizardStep(
        { chatbotConfigStep: mockState.chatbotConfigStep } as never,
        'c1',
        'bogus',
      );
      throw new Error('expected throw');
    } catch (e) {
      expect((e as WizardClientError).error).toEqual({ code: 'invalid_step_key' });
    }
  });

  it('returns null when neither latest nor active exist', async () => {
    mockState.chatbotConfigStep.findFirst.mockResolvedValue(null);
    const out = await readWizardStep(
      { chatbotConfigStep: mockState.chatbotConfigStep } as never,
      'c1',
      '1',
    );
    expect(out).toBeNull();
  });

  it('returns latest + active when both exist', async () => {
    mockState.chatbotConfigStep.findFirst
      .mockResolvedValueOnce({ id: 's2', version: 2, status: 'submitted', payload: { v: 2 }, submittedAt: null, approvedAt: null, activeForBot: false, createdAt: new Date(), updatedAt: new Date() })
      .mockResolvedValueOnce({ id: 's1', version: 1, status: 'approved', payload: { v: 1 }, submittedAt: null, approvedAt: new Date(), activeForBot: true, createdAt: new Date(), updatedAt: new Date() });
    const out = await readWizardStep(
      { chatbotConfigStep: mockState.chatbotConfigStep } as never,
      'c1',
      '1',
    );
    expect(out?.latest?.id).toBe('s2');
    expect(out?.active?.id).toBe('s1');
    expect(out?.active?.activeForBot).toBe(true);
  });
});
