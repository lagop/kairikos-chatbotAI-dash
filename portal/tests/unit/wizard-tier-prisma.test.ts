// =============================================================================
// WP-13 — unit tests for src/lib/wizard-tier-prisma.ts
//
// No prior unit coverage existed for this file. Focused on the productCode
// scoping this WP added to readLatestStepsForClient/readLatestStepForClient
// — resolveClientTier and jsonToObject are deliberately excluded (see the
// comments on those functions in the source file for why).
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  readLatestStepsForClient,
  readLatestStepForClient,
  resolveClientTier,
} from '@/lib/wizard-tier-prisma';

function makePrisma(overrides: { findMany?: unknown; findFirst?: unknown; findUnique?: unknown } = {}) {
  return {
    chatbotConfigStep: {
      findMany: vi.fn().mockResolvedValue(overrides.findMany ?? []),
      findFirst: vi.fn().mockResolvedValue(overrides.findFirst ?? null),
    },
    chatbotClient: {
      findUnique: vi.fn().mockResolvedValue(overrides.findUnique ?? null),
    },
  } as never;
}

describe('readLatestStepsForClient', () => {
  it('scopes the query by (clientId, productCode)', async () => {
    const prisma = makePrisma();
    await readLatestStepsForClient(prisma, 'client-1', 'web');
    expect((prisma as any).chatbotConfigStep.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client-1', productCode: 'web' } }),
    );
  });

  it('reduces to the highest version per stepKey', async () => {
    const prisma = makePrisma({
      findMany: [
        { stepKey: '1', version: 2, status: 'approved', submittedAt: null, approvedAt: null, activeForBot: true },
        { stepKey: '1', version: 1, status: 'draft', submittedAt: null, approvedAt: null, activeForBot: false },
        { stepKey: '2', version: 1, status: 'draft', submittedAt: null, approvedAt: null, activeForBot: false },
      ],
    });
    const rows = await readLatestStepsForClient(prisma, 'client-1', 'chatbot');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.stepKey === '1')?.latest?.version).toBeUndefined(); // version isn't in SavedStepRow
    expect(rows.find((r) => r.stepKey === '1')?.latest?.status).toBe('approved');
  });
});

describe('readLatestStepForClient', () => {
  it('scopes the query by (clientId, productCode, stepKey)', async () => {
    const prisma = makePrisma();
    await readLatestStepForClient(prisma, 'client-1', 'web', '1');
    expect((prisma as any).chatbotConfigStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client-1', productCode: 'web', stepKey: '1' } }),
    );
  });

  it('two different products never resolve the same underlying row from one mock call', async () => {
    const chatbotRow = { status: 'approved', submittedAt: null, approvedAt: null, activeForBot: true, payload: { a: 1 } };
    const webRow = { status: 'draft', submittedAt: null, approvedAt: null, activeForBot: false, payload: { b: 2 } };
    const findFirst = vi
      .fn()
      .mockImplementation(({ where }: { where: { productCode: string } }) =>
        Promise.resolve(where.productCode === 'chatbot' ? chatbotRow : webRow),
      );
    const prisma = { chatbotConfigStep: { findFirst } } as never;

    const chatbotResult = await readLatestStepForClient(prisma, 'client-1', 'chatbot', '1');
    const webResult = await readLatestStepForClient(prisma, 'client-1', 'web', '1');

    expect(chatbotResult?.latest?.status).toBe('approved');
    expect(webResult?.latest?.status).toBe('draft');
  });

  it('returns null when no row exists', async () => {
    const prisma = makePrisma({ findFirst: null });
    const result = await readLatestStepForClient(prisma, 'client-1', 'chatbot', '1');
    expect(result).toBeNull();
  });
});

describe('resolveClientTier', () => {
  it('has no productCode parameter — it only reads ChatbotClient', async () => {
    const prisma = makePrisma({ findUnique: { id: 'client-1', email: 'a@b.com', tier: 'pro' } });
    const result = await resolveClientTier(prisma, 'client-1');
    expect(result?.tier).toBe('pro');
  });
});
