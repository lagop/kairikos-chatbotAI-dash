// =============================================================================
// SEO con IA, Fase A — unit tests for
// PATCH /api/admin/portal/seo/[clientId]/technical-setup. Includes a
// regression test for the legacy KAIA_OPERATOR_API_KEY auth bug found and
// fixed on the Google Places integrations route (authenticateAdminRequest
// returns the placeholder id 'legacy', which is not a real Operator row).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  profileFindFirst: vi.fn(),
  profileUpdate: vi.fn(),
  auditCreate: vi.fn(),
  encryptWordPressAppPassword: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  seoProfile: { update: (...a: unknown[]) => mockState.profileUpdate(...a) },
  seoProfileAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
};

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/seo', () => ({
  encryptWordPressAppPassword: (...a: unknown[]) => mockState.encryptWordPressAppPassword(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    seoProfile: { findFirst: (...a: unknown[]) => mockState.profileFindFirst(...a) },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { PATCH } from '@/app/api/admin/portal/seo/[clientId]/technical-setup/route';

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

async function patch(clientId: string, body: unknown) {
  return PATCH(makeRequest(body), { params: { clientId } });
}

const EXISTING_PROFILE = {
  id: 'profile_1',
  tenantId: 't1',
  wordpressUrl: null,
  wordpressUsername: null,
  wordpressAppPasswordCiphertext: null,
  technicalSetupNotes: null,
  technicalSetupCompletedAt: null,
};
const ENCRYPTED = { ciphertext: Buffer.from('c'), iv: Buffer.from('i'), tag: Buffer.from('t') };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.profileFindFirst.mockReset().mockResolvedValue(EXISTING_PROFILE);
  mockState.profileUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'profile_1', ...EXISTING_PROFILE, ...data }),
  );
  mockState.auditCreate.mockReset();
  mockState.encryptWordPressAppPassword.mockReset().mockReturnValue(ENCRYPTED);
  mockState.logError.mockReset();
});

describe('PATCH /api/admin/portal/seo/[clientId]/technical-setup', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await patch('client_1', { wordpressUrl: 'https://x.example/wp-admin' });
    expect(res.status).toBe(401);
  });

  it('400s on an empty body', async () => {
    const res = await patch('client_1', {});
    expect(res.status).toBe(400);
    expect(mockState.profileFindFirst).not.toHaveBeenCalled();
  });

  it('404s when the client has no SeoProfile yet', async () => {
    mockState.profileFindFirst.mockResolvedValue(null);
    const res = await patch('client_1', { wordpressUrl: 'https://x.example/wp-admin' });
    expect(res.status).toBe(404);
    expect(mockState.profileUpdate).not.toHaveBeenCalled();
  });

  it('encrypts and saves the app password, stamps technicalSetupCompletedAt once both URL and password are present', async () => {
    const res = await patch('client_1', {
      wordpressUrl: 'https://negocio.example/wp-admin',
      wordpressUsername: 'admin',
      wordpressAppPassword: 'xxxx xxxx xxxx xxxx',
    });
    expect(res.status).toBe(200);
    expect(mockState.encryptWordPressAppPassword).toHaveBeenCalledWith('xxxx xxxx xxxx xxxx');
    expect(mockState.profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile_1' },
        data: expect.objectContaining({
          wordpressUrl: 'https://negocio.example/wp-admin',
          wordpressUsername: 'admin',
          wordpressAppPasswordCiphertext: ENCRYPTED.ciphertext,
          wordpressAppPasswordIv: ENCRYPTED.iv,
          wordpressAppPasswordTag: ENCRYPTED.tag,
          technicalSetupCompletedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not re-stamp technicalSetupCompletedAt on a later edit', async () => {
    mockState.profileFindFirst.mockResolvedValue({
      ...EXISTING_PROFILE,
      wordpressUrl: 'https://negocio.example/wp-admin',
      wordpressAppPasswordCiphertext: Buffer.from('existing'),
      technicalSetupCompletedAt: new Date('2026-09-01'),
    });
    await patch('client_1', { technicalSetupNotes: 'nota nueva' });
    const updateData = mockState.profileUpdate.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('technicalSetupCompletedAt');
  });

  it('leaving the app password blank keeps the existing one — never overwrites with nothing', async () => {
    mockState.profileFindFirst.mockResolvedValue({
      ...EXISTING_PROFILE,
      wordpressAppPasswordCiphertext: Buffer.from('existing'),
    });
    await patch('client_1', { technicalSetupNotes: 'solo una nota' });
    expect(mockState.encryptWordPressAppPassword).not.toHaveBeenCalled();
    const updateData = mockState.profileUpdate.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('wordpressAppPasswordCiphertext');
  });

  it('the audit before/after never contains the plaintext or ciphertext password — only hasAppPassword', async () => {
    await patch('client_1', { wordpressUrl: 'https://x.example', wordpressAppPassword: 'super-secret-value' });
    const auditData = mockState.auditCreate.mock.calls[0][0].data;
    expect(JSON.stringify(auditData)).not.toContain('super-secret-value');
    expect(auditData.after).toHaveProperty('hasAppPassword', true);
  });

  it('audits with actorType:operator and the resolved operator email', async () => {
    await patch('client_1', { wordpressUrl: 'https://x.example' });
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorType: 'operator', actorOperatorId: 'op_1', actorEmail: 'op@kairikos.com' }),
      }),
    );
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path saves with a null actorOperatorId instead of crashing on a non-UUID lookup', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await patch('client_1', { wordpressUrl: 'https://x.example' });
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorOperatorId: null, actorEmail: null }) }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('client_1', { wordpressUrl: 'https://x.example' });
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when the transaction throws', async () => {
    mockState.profileUpdate.mockRejectedValue(new Error('db down'));
    const res = await patch('client_1', { wordpressUrl: 'https://x.example' });
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
