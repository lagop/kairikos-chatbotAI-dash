// =============================================================================
// WP-10 — unit tests for getFlowHealthRows() in src/lib/flow-health.ts
//
// This is the single per-client "last activity + last n8n execution" read,
// now shared between GET /api/admin/portal/flows and admin/portal/flows/page.tsx.
// Before WP-10 the page had its own copy that never joined n8nExecutions —
// every row's lastN8nStatus was hardcoded to 'unknown'. These tests assert
// the join actually reflects what's in the DB.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { getFlowHealthRows, STUCK_DAYS } from '@/lib/flow-health';

function makePrisma(clients: unknown[]) {
  return {
    chatbotClient: {
      findMany: vi.fn().mockResolvedValue(clients),
    },
  } as never;
}

describe('getFlowHealthRows', () => {
  it('maps a successful last n8n execution to lastN8nStatus: success (not hardcoded unknown)', async () => {
    const prisma = makePrisma([
      {
        id: 'c1',
        companyName: 'Acme Corp',
        name: 'Acme',
        tier: 'pro',
        activities: [{ completedAt: new Date(), milestone: 'T+3' }],
        n8nExecutions: [{ status: 'success', startedAt: new Date('2026-08-13T09:00:00Z') }],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows[0].lastN8nStatus).toBe('success');
    expect(rows[0].lastN8nAt).toBe('2026-08-13T09:00:00.000Z');
  });

  it('maps a failed last n8n execution to lastN8nStatus: failed', async () => {
    const prisma = makePrisma([
      {
        id: 'c1',
        companyName: null,
        name: 'Acme',
        tier: 'pro',
        activities: [],
        n8nExecutions: [{ status: 'failed', startedAt: new Date('2026-08-13T09:00:00Z') }],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows[0].lastN8nStatus).toBe('failed');
    expect(rows[0].companyName).toBe('Acme');
  });

  it('distinguishes "no n8n execution at all" (unknown) from a real outcome', async () => {
    const prisma = makePrisma([
      {
        id: 'c1',
        companyName: 'Acme Corp',
        name: 'Acme',
        tier: 'pro',
        activities: [],
        n8nExecutions: [],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows[0].lastN8nStatus).toBe('unknown');
    expect(rows[0].lastN8nAt).toBeNull();
  });

  it(`marks a client stuck when its last activity is more than ${STUCK_DAYS} days old`, async () => {
    const staleDate = new Date(Date.now() - (STUCK_DAYS + 1) * 24 * 60 * 60 * 1000);
    const prisma = makePrisma([
      {
        id: 'c1',
        companyName: 'Acme Corp',
        name: 'Acme',
        tier: 'pro',
        activities: [{ completedAt: staleDate, milestone: 'T+3' }],
        n8nExecutions: [],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows[0].stuck).toBe(true);
    expect(rows[0].daysInMilestone).toBeGreaterThan(STUCK_DAYS);
  });

  it('sorts stuck clients first, then by longest time in milestone', async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    const prisma = makePrisma([
      {
        id: 'fresh',
        companyName: 'Fresh Co',
        name: 'Fresh',
        tier: 'starter',
        activities: [{ completedAt: daysAgo(1), milestone: 'T+0' }],
        n8nExecutions: [],
      },
      {
        id: 'very-stuck',
        companyName: 'Very Stuck Co',
        name: 'VeryStuck',
        tier: 'pro',
        activities: [{ completedAt: daysAgo(10), milestone: 'T+7' }],
        n8nExecutions: [],
      },
      {
        id: 'a-bit-stuck',
        companyName: 'A Bit Stuck Co',
        name: 'ABitStuck',
        tier: 'pro',
        activities: [{ completedAt: daysAgo(4), milestone: 'T+3' }],
        n8nExecutions: [],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows.map((r) => r.id)).toEqual(['very-stuck', 'a-bit-stuck', 'fresh']);
  });

  it('falls back to name when companyName is null', async () => {
    const prisma = makePrisma([
      {
        id: 'c1',
        companyName: null,
        name: 'Fallback Name',
        tier: 'starter',
        activities: [],
        n8nExecutions: [],
      },
    ]);

    const rows = await getFlowHealthRows(prisma);

    expect(rows[0].companyName).toBe('Fallback Name');
  });
});
