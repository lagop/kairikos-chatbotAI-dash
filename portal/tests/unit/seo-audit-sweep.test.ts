// =============================================================================
// SEO con IA, Fase 5 — unit tests for isAuditDue / sweepDueSiteAudits in
// src/lib/seo-audit.ts.
//
// sweepDueSiteAudits calls auditWebsite() as a plain sibling function in
// the SAME module, so it can't be mocked via vi.mock the way
// seo-content-generation.ts's sweep mocks its AI dependency (a
// same-module internal call is not something vi.mock can intercept).
// Instead this stubs `fetch`, same convention as seo-audit.test.ts, and
// lets the real auditWebsite() run inside the sweep — a more thorough
// check anyway, since it also proves the Prisma orchestration and the
// real audit function compose correctly end to end.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAuditDue, sweepDueSiteAudits, SITE_AUDIT_MIN_INTERVAL_DAYS } from '@/lib/seo-audit';

const mockState = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mockState.fetch);

function htmlResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body,
  } as unknown as Response;
}

const NOW = new Date('2026-09-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('isAuditDue', () => {
  it('is due when there is no prior audit', () => {
    expect(isAuditDue(null)).toBe(true);
  });

  it('is not due before the interval elapses', () => {
    const lastAuditAt = new Date(Date.now() - (SITE_AUDIT_MIN_INTERVAL_DAYS - 1) * DAY_MS);
    expect(isAuditDue(lastAuditAt)).toBe(false);
  });

  it('is due once the interval elapses', () => {
    const lastAuditAt = new Date(Date.now() - (SITE_AUDIT_MIN_INTERVAL_DAYS + 1) * DAY_MS);
    expect(isAuditDue(lastAuditAt)).toBe(true);
  });
});

function makePrisma(profiles: unknown[]) {
  const updateCalls: unknown[] = [];
  const auditCreateCalls: unknown[] = [];
  const tx = {
    seoProfile: { update: (args: unknown) => { updateCalls.push(args); return Promise.resolve({}); } },
    seoProfileAudit: { create: (args: unknown) => { auditCreateCalls.push(args); return Promise.resolve({}); } },
  };
  return {
    prisma: {
      seoProfile: {
        findMany: vi.fn().mockResolvedValue(profiles),
        update: (args: unknown) => { updateCalls.push(args); return Promise.resolve({}); },
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as never,
    updateCalls,
    auditCreateCalls,
  };
}

describe('sweepDueSiteAudits', () => {
  beforeEach(() => {
    mockState.fetch.mockReset();
  });

  it('only asks for profiles with a siteUrl and an active seo product', async () => {
    const { prisma } = makePrisma([]);
    await sweepDueSiteAudits(prisma, NOW);
    expect((prisma.seoProfile.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { siteUrl: { not: null }, clientProduct: { status: 'active' } },
      }),
    );
  });

  it('audits a profile past the window and stamps lastAuditAt/lastAuditResult', async () => {
    mockState.fetch.mockResolvedValueOnce(htmlResponse('<html><head><title>Negocio</title></head><body></body></html>'));
    const { prisma, updateCalls, auditCreateCalls } = makePrisma([
      { id: 'p1', clientId: 'c1', tenantId: 't1', siteUrl: 'https://negocio.example', lastAuditAt: null },
    ]);

    const result = await sweepDueSiteAudits(prisma, NOW);

    expect(result).toEqual({ due: 1, processed: 1, audited: 1, failed: 0 });
    expect(updateCalls).toEqual([
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ lastAuditAt: NOW, lastAuditError: null }),
      }),
    ]);
    expect(auditCreateCalls).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ profileId: 'p1', clientId: 'c1', action: 'audit_run', actorType: 'system', actorOperatorId: null, actorEmail: null }),
      }),
    ]);
  });

  it('leaves a profile inside the window alone', async () => {
    const { prisma, updateCalls } = makePrisma([
      { id: 'p1', clientId: 'c1', tenantId: 't1', siteUrl: 'https://negocio.example', lastAuditAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ]);
    const result = await sweepDueSiteAudits(prisma, NOW);
    expect(result).toEqual({ due: 0, processed: 0, audited: 0, failed: 0 });
    expect(updateCalls).toEqual([]);
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('on a failed audit, records lastAuditError but never stamps lastAuditAt', async () => {
    mockState.fetch.mockResolvedValueOnce(htmlResponse('not found', false, 404));
    const { prisma, updateCalls } = makePrisma([
      { id: 'p1', clientId: 'c1', tenantId: 't1', siteUrl: 'https://caido.example', lastAuditAt: null },
    ]);

    const result = await sweepDueSiteAudits(prisma, NOW);

    expect(result).toEqual({ due: 1, processed: 1, audited: 0, failed: 1 });
    expect(updateCalls).toEqual([{ where: { id: 'p1' }, data: { lastAuditError: 'http_404' } }]);
  });

  it('isolates one failing site so the rest of the tick still gets audited', async () => {
    mockState.fetch
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockResolvedValueOnce(htmlResponse('<html><head><title>OK</title></head></html>'));
    const { prisma, updateCalls } = makePrisma([
      { id: 'p1', clientId: 'c1', tenantId: 't1', siteUrl: 'https://roto.example', lastAuditAt: null },
      { id: 'p2', clientId: 'c2', tenantId: 't2', siteUrl: 'https://bien.example', lastAuditAt: null },
    ]);

    const result = await sweepDueSiteAudits(prisma, NOW);

    expect(result.due).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.audited).toBe(1);
    expect(result.failed).toBe(1);
    // p1 falló: solo se le escribe lastAuditError, nunca lastAuditAt.
    expect(updateCalls).toContainEqual({ where: { id: 'p1' }, data: { lastAuditError: 'ENOTFOUND' } });
    // p2 se auditó de verdad.
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ where: { id: 'p2' }, data: expect.objectContaining({ lastAuditAt: NOW }) }),
    );
  });
});
