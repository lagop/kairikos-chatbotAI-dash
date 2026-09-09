// =============================================================================
// Fase 6 — unit tests for lib/product-onboarding.ts.
//
// Covers the "Un hook de aprovisionamiento al activar" gap "Cadena de
// entrega por producto" flagged for 'seo', 'prospecting' and 'leads':
// none of the three ever got their profile row created at purchase time,
// only lazily on the client's first save. Same shape of tests as
// recall-onboarding.test.ts's ensureRecallSubscription coverage.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ensureSeoProfile, ensureProspectingCampaign, ensureLeadQualificationProfile } from '@/lib/product-onboarding';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint', { code: 'P2002', clientVersion: 'test' });
}

// ---------------------------------------------------------------------------
// ensureSeoProfile
// ---------------------------------------------------------------------------

interface FakeSeoTx {
  seoProfile: { create: ReturnType<typeof vi.fn> };
  seoProfileAudit: { create: ReturnType<typeof vi.fn> };
}

function makeSeoPrisma() {
  const tx: FakeSeoTx = {
    seoProfile: { create: vi.fn().mockResolvedValue({ id: 'profile_new', status: 'onboarding' }) },
    seoProfileAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const findUnique = vi.fn().mockResolvedValue(null);
  const findUniqueOrThrow = vi.fn();
  const prisma = {
    seoProfile: { findUnique, findUniqueOrThrow },
    $transaction: (fn: (tx: FakeSeoTx) => unknown) => fn(tx),
  } as never;
  return { prisma, findUnique, findUniqueOrThrow, tx };
}

describe('ensureSeoProfile', () => {
  it('creates an empty profile with a system actor when none exists', async () => {
    const { prisma, tx } = makeSeoPrisma();

    const result = await ensureSeoProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: true, id: 'profile_new' });
    expect(tx.seoProfile.create).toHaveBeenCalledWith({
      data: { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
    });
    expect(tx.seoProfileAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        profileId: 'profile_new',
        action: 'created',
        actorType: 'system',
        actorOperatorId: null,
        actorEmail: 'system:stripe_checkout',
      }),
    });
  });

  it('writes an operator actor without resolving an email', async () => {
    const { prisma, tx } = makeSeoPrisma();
    await ensureSeoProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: null },
      { type: 'operator', operatorId: 'op_1' },
    );
    expect(tx.seoProfileAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: 'operator', actorOperatorId: 'op_1', actorEmail: null }),
    });
  });

  it('is a no-op when a profile already exists for this ClientProduct', async () => {
    const { prisma, findUnique, tx } = makeSeoPrisma();
    findUnique.mockResolvedValueOnce({ id: 'profile_existing' });

    const result = await ensureSeoProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'profile_existing' });
    expect(tx.seoProfile.create).not.toHaveBeenCalled();
  });

  it('treats a P2002 race as the winner already having created it', async () => {
    const { prisma, tx, findUniqueOrThrow } = makeSeoPrisma();
    tx.seoProfile.create.mockRejectedValueOnce(p2002());
    findUniqueOrThrow.mockResolvedValueOnce({ id: 'profile_winner' });

    const result = await ensureSeoProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'profile_winner' });
  });

  it('rethrows any other error', async () => {
    const { prisma, tx } = makeSeoPrisma();
    tx.seoProfile.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      ensureSeoProfile(
        prisma,
        { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
        { type: 'system', source: 'stripe_checkout' },
      ),
    ).rejects.toThrow('db down');
  });
});

// ---------------------------------------------------------------------------
// ensureProspectingCampaign
// ---------------------------------------------------------------------------

interface FakeProspectingTx {
  prospectingCampaign: { create: ReturnType<typeof vi.fn> };
  prospectingCampaignAudit: { create: ReturnType<typeof vi.fn> };
}

function makeProspectingPrisma() {
  const tx: FakeProspectingTx = {
    prospectingCampaign: { create: vi.fn().mockResolvedValue({ id: 'campaign_new', monthlyLeadCap: 300 }) },
    prospectingCampaignAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const findUnique = vi.fn().mockResolvedValue(null);
  const findUniqueOrThrow = vi.fn();
  const prisma = {
    prospectingCampaign: { findUnique, findUniqueOrThrow },
    $transaction: (fn: (tx: FakeProspectingTx) => unknown) => fn(tx),
  } as never;
  return { prisma, findUnique, findUniqueOrThrow, tx };
}

describe('ensureProspectingCampaign', () => {
  it('creates an empty campaign with monthlyLeadCap resolved from the tier', async () => {
    const { prisma, tx } = makeProspectingPrisma();

    const result = await ensureProspectingCampaign(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', tier: 'team' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: true, id: 'campaign_new' });
    expect(tx.prospectingCampaign.create).toHaveBeenCalledWith({
      data: { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', monthlyLeadCap: 300 },
    });
    expect(tx.prospectingCampaignAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ campaignId: 'campaign_new', action: 'created', actorId: 'system:stripe_checkout' }),
    });
  });

  it('falls back to the solo cap for an unknown tier, same as the client route', async () => {
    const { prisma, tx } = makeProspectingPrisma();
    await ensureProspectingCampaign(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', tier: 'nonexistent' },
      { type: 'system', source: 'stripe_checkout' },
    );
    expect(tx.prospectingCampaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ monthlyLeadCap: 100 }),
    });
  });

  it('writes the raw operator id as actorId, and "legacy" when there is none', async () => {
    const { prisma, tx } = makeProspectingPrisma();
    await ensureProspectingCampaign(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', tier: 'solo' },
      { type: 'operator', operatorId: null },
    );
    expect(tx.prospectingCampaignAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: 'legacy' }),
    });
  });

  it('is a no-op when a campaign already exists for this ClientProduct', async () => {
    const { prisma, findUnique, tx } = makeProspectingPrisma();
    findUnique.mockResolvedValueOnce({ id: 'campaign_existing' });

    const result = await ensureProspectingCampaign(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', tier: 'solo' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'campaign_existing' });
    expect(tx.prospectingCampaign.create).not.toHaveBeenCalled();
  });

  it('treats a P2002 race as the winner already having created it', async () => {
    const { prisma, tx, findUniqueOrThrow } = makeProspectingPrisma();
    tx.prospectingCampaign.create.mockRejectedValueOnce(p2002());
    findUniqueOrThrow.mockResolvedValueOnce({ id: 'campaign_winner' });

    const result = await ensureProspectingCampaign(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1', tier: 'solo' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'campaign_winner' });
  });
});

// ---------------------------------------------------------------------------
// ensureLeadQualificationProfile
// ---------------------------------------------------------------------------

interface FakeLeadsTx {
  leadQualificationProfile: { create: ReturnType<typeof vi.fn> };
  leadQualificationProfileAudit: { create: ReturnType<typeof vi.fn> };
}

function makeLeadsPrisma() {
  const tx: FakeLeadsTx = {
    leadQualificationProfile: { create: vi.fn().mockResolvedValue({ id: 'lqp_new' }) },
    leadQualificationProfileAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const findUnique = vi.fn().mockResolvedValue(null);
  const findUniqueOrThrow = vi.fn();
  const prisma = {
    leadQualificationProfile: { findUnique, findUniqueOrThrow },
    $transaction: (fn: (tx: FakeLeadsTx) => unknown) => fn(tx),
  } as never;
  return { prisma, findUnique, findUniqueOrThrow, tx };
}

describe('ensureLeadQualificationProfile', () => {
  it('creates an empty profile with a formatted system actorEmail', async () => {
    const { prisma, tx } = makeLeadsPrisma();

    const result = await ensureLeadQualificationProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: true, id: 'lqp_new' });
    expect(tx.leadQualificationProfile.create).toHaveBeenCalledWith({
      data: { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
    });
    expect(tx.leadQualificationProfileAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ profileId: 'lqp_new', action: 'created', actorEmail: 'system:stripe_checkout' }),
    });
  });

  it('formats an operator actorEmail as operator:<id>, and operator:legacy when there is none', async () => {
    const { prisma, tx } = makeLeadsPrisma();
    await ensureLeadQualificationProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: null },
      { type: 'operator', operatorId: null },
    );
    expect(tx.leadQualificationProfileAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorEmail: 'operator:legacy' }),
    });
  });

  it('is a no-op when a profile already exists for this ClientProduct', async () => {
    const { prisma, findUnique, tx } = makeLeadsPrisma();
    findUnique.mockResolvedValueOnce({ id: 'lqp_existing' });

    const result = await ensureLeadQualificationProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'lqp_existing' });
    expect(tx.leadQualificationProfile.create).not.toHaveBeenCalled();
  });

  it('treats a P2002 race as the winner already having created it', async () => {
    const { prisma, tx, findUniqueOrThrow } = makeLeadsPrisma();
    tx.leadQualificationProfile.create.mockRejectedValueOnce(p2002());
    findUniqueOrThrow.mockResolvedValueOnce({ id: 'lqp_winner' });

    const result = await ensureLeadQualificationProfile(
      prisma,
      { clientId: 'client_1', clientProductId: 'cp_1', tenantId: 'tenant_1' },
      { type: 'system', source: 'stripe_checkout' },
    );

    expect(result).toEqual({ created: false, id: 'lqp_winner' });
  });
});
