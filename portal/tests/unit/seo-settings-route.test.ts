// =============================================================================
// Unit tests for /api/admin/portal/settings/seo. Same mocking
// conventions as integrations-google-places-route.test.ts, minus TOTP
// step-up — a cadence value, not a secret or a payment credential.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  getContentGenerationMinIntervalDays: vi.fn(),
  updateContentGenerationMinIntervalDays: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
  },
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/seo-settings', () => ({
  getContentGenerationMinIntervalDays: (...a: unknown[]) => mockState.getContentGenerationMinIntervalDays(...a),
  updateContentGenerationMinIntervalDays: (...a: unknown[]) => mockState.updateContentGenerationMinIntervalDays(...a),
  MIN_CONTENT_GENERATION_INTERVAL_DAYS: 1,
  MAX_CONTENT_GENERATION_INTERVAL_DAYS: 90,
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { GET, POST } from '@/app/api/admin/portal/settings/seo/route';

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.getContentGenerationMinIntervalDays.mockReset().mockResolvedValue(3);
  mockState.updateContentGenerationMinIntervalDays.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
});

describe('GET /api/admin/portal/settings/seo', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns the current interval', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValue(10);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ contentGenerationMinIntervalDays: 10 });
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/admin/portal/settings/seo', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 5 }));
    expect(res.status).toBe(401);
    expect(mockState.updateContentGenerationMinIntervalDays).not.toHaveBeenCalled();
  });

  it('400s on a missing body', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
  });

  it('400s on a non-integer value', async () => {
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 3.5 }));
    expect(res.status).toBe(400);
  });

  it('400s below the minimum (1)', async () => {
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 0 }));
    expect(res.status).toBe(400);
  });

  it('400s above the maximum (90)', async () => {
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 91 }));
    expect(res.status).toBe(400);
  });

  it('saves the value with the resolved operator email', async () => {
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, contentGenerationMinIntervalDays: 5 });
    expect(mockState.updateContentGenerationMinIntervalDays).toHaveBeenCalledWith(5, 'op@kairikos.com');
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path saves with a fallback actor instead of crashing', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 5 }));
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.updateContentGenerationMinIntervalDays).toHaveBeenCalledWith(5, 'legacy_operator');
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 5 }));
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when saving throws', async () => {
    mockState.updateContentGenerationMinIntervalDays.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest({ contentGenerationMinIntervalDays: 5 }));
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
