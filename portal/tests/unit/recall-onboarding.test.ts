// =============================================================================
// Fase 6 — unit tests for lib/recall-onboarding.ts.
//
// Covers the two gaps "Cadena de entrega por producto" flagged for
// 'recall': ensureRecallSubscription (nothing in the repo ever created a
// RecallSubscription) and markContractSigned (contract_signed had no
// writer).
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ensureRecallSubscription, markContractSigned } from '@/lib/recall-onboarding';

interface FakeTx {
  recallSubscription: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  recallSubscriptionAudit: { create: ReturnType<typeof vi.fn> };
}

function makeEnsurePrisma(): { prisma: never; findUnique: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn>; tx: FakeTx } {
  const tx: FakeTx = {
    recallSubscription: {
      create: vi.fn().mockResolvedValue({ id: 'sub_new' }),
      update: vi.fn().mockResolvedValue({}),
    },
    recallSubscriptionAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const findUnique = vi.fn().mockResolvedValue(null);
  const findUniqueOrThrow = vi.fn();
  const prisma = {
    recallSubscription: { findUnique, findUniqueOrThrow },
    $transaction: (fn: (tx: FakeTx) => unknown) => fn(tx),
  } as never;
  return { prisma, findUnique, findUniqueOrThrow, tx };
}

describe('ensureRecallSubscription', () => {
  it('creates a subscription in the default paid state when none exists, with a system actor', async () => {
    const { prisma, tx } = makeEnsurePrisma();

    const result = await ensureRecallSubscription(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: true, subscriptionId: 'sub_new' });
    expect(tx.recallSubscription.create).toHaveBeenCalledWith({
      data: { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
    });
    expect(tx.recallSubscriptionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: 'sub_new',
        clientId: 'client_1',
        action: 'created',
        after: { status: 'paid' },
        actorType: 'system',
        actorOperatorId: null,
        actorEmail: 'system:stripe_checkout',
      }),
    });
  });

  it('writes an operator actor when an operator triggers it, never a synthetic id', async () => {
    const { prisma, tx } = makeEnsurePrisma();
    await ensureRecallSubscription(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: null },
      { type: 'operator', operatorId: 'op_1' },
    );
    expect(tx.recallSubscriptionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: 'operator', actorOperatorId: 'op_1', actorEmail: null }),
    });
  });

  it('is a no-op when a subscription already exists for this ClientProduct', async () => {
    const { prisma, findUnique, tx } = makeEnsurePrisma();
    findUnique.mockResolvedValueOnce({ id: 'sub_existing' });

    const result = await ensureRecallSubscription(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, subscriptionId: 'sub_existing' });
    expect(tx.recallSubscription.create).not.toHaveBeenCalled();
  });

  it('treats a P2002 race (two activations at once) as success, not a crash', async () => {
    const { prisma, findUniqueOrThrow, tx } = makeEnsurePrisma();
    tx.recallSubscription.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    findUniqueOrThrow.mockResolvedValueOnce({ id: 'sub_winner' });

    const result = await ensureRecallSubscription(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, subscriptionId: 'sub_winner' });
  });

  it('re-throws any other database error instead of swallowing it', async () => {
    const { prisma, tx } = makeEnsurePrisma();
    tx.recallSubscription.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      ensureRecallSubscription(
        prisma,
        { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
        { type: 'system', source: 'stripe_checkout' },
      ),
    ).rejects.toThrow('connection reset');
  });
});

function makeMarkPrisma(subscription: unknown): { prisma: never; tx: FakeTx } {
  const tx: FakeTx = {
    recallSubscription: { create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    recallSubscriptionAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    recallSubscription: { findUnique: vi.fn().mockResolvedValue(subscription) },
    $transaction: (fn: (tx: FakeTx) => unknown) => fn(tx),
  } as never;
  return { prisma, tx };
}

describe('markContractSigned', () => {
  it('advances a paid subscription to contract_signed and stamps contractSignedAt', async () => {
    const { prisma, tx } = makeMarkPrisma({ id: 'sub_1', clientId: 'client_1', status: 'paid' });

    const result = await markContractSigned(prisma, 'sub_1', { operatorId: 'op_1' });

    expect(result).toEqual({ ok: true });
    expect(tx.recallSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: expect.objectContaining({ status: 'contract_signed', contractSignedAt: expect.any(Date) }),
    });
  });

  it('writes the audit row with an operator actor', async () => {
    const { prisma, tx } = makeMarkPrisma({ id: 'sub_1', clientId: 'client_1', status: 'paid' });
    await markContractSigned(prisma, 'sub_1', { operatorId: 'op_1' });
    expect(tx.recallSubscriptionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: 'sub_1',
        clientId: 'client_1',
        action: 'contract_signed',
        before: { status: 'paid' },
        after: { status: 'contract_signed' },
        actorType: 'operator',
        actorOperatorId: 'op_1',
      }),
    });
  });

  it('never writes a synthetic operator id for the legacy auth path', async () => {
    const { prisma, tx } = makeMarkPrisma({ id: 'sub_1', clientId: 'client_1', status: 'paid' });
    await markContractSigned(prisma, 'sub_1', { operatorId: null });
    expect(tx.recallSubscriptionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorOperatorId: null }),
    });
  });

  it('rejects with subscription_not_found when the row does not exist', async () => {
    const { prisma } = makeMarkPrisma(null);
    const result = await markContractSigned(prisma, 'sub_missing', { operatorId: 'op_1' });
    expect(result).toEqual({ ok: false, error: 'subscription_not_found' });
  });

  it.each(['contract_signed', 'meta_connected', 'active', 'cancelled'])(
    'rejects with invalid_status when the subscription is already past paid (%s)',
    async (status) => {
      const { prisma, tx } = makeMarkPrisma({ id: 'sub_1', clientId: 'client_1', status });
      const result = await markContractSigned(prisma, 'sub_1', { operatorId: 'op_1' });
      expect(result).toEqual({ ok: false, error: 'invalid_status' });
      expect(tx.recallSubscription.update).not.toHaveBeenCalled();
    },
  );
});
