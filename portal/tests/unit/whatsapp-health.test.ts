// =============================================================================
// WP-XX — unit tests for the WhatsApp health jobs.
//
// Both exist because Meta changes state without telling us, and both
// failures are silent by nature: the product keeps looking fine right up
// until a client's messages stop arriving. So the properties under test
// are about NOT being silent — warning before the expiry rather than
// after, and never consuming the one warning on a send that failed.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  decryptMetaToken: vi.fn(),
  listMessageTemplates: vi.fn(),
  sendOperatorNotification: vi.fn(),
  resolveOperatorRecipients: vi.fn(),
}));

vi.mock('@/lib/meta-business', () => ({
  decryptMetaToken: (...a: unknown[]) => mockState.decryptMetaToken(...a),
}));
vi.mock('@/lib/whatsapp-api', () => ({
  listMessageTemplates: (...a: unknown[]) => mockState.listMessageTemplates(...a),
}));
vi.mock('@/lib/operator-notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator-notify')>('@/lib/operator-notify');
  return {
    ...actual,
    sendOperatorNotification: (...a: unknown[]) => mockState.sendOperatorNotification(...a),
    resolveOperatorRecipients: (...a: unknown[]) => mockState.resolveOperatorRecipients(...a),
  };
});

const state = {
  connectionFindMany: vi.fn(),
  connectionUpdate: vi.fn(),
  templateUpsert: vi.fn(),
};

const prisma = {
  metaChannelConnection: {
    findMany: (...a: unknown[]) => state.connectionFindMany(...a),
    update: (...a: unknown[]) => state.connectionUpdate(...a),
  },
  whatsappTemplate: { upsert: (...a: unknown[]) => state.templateUpsert(...a) },
} as unknown as PrismaClient;

const NOW = new Date('2026-11-01T12:00:00.000Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const CONNECTION = {
  id: 'conn_1',
  clientId: 'client_1',
  wabaId: 'waba_1',
  accessTokenCiphertext: Buffer.from('c'),
  accessTokenIv: Buffer.from('i'),
  accessTokenTag: Buffer.from('t'),
};

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.decryptMetaToken.mockReset().mockReturnValue('token');
  mockState.listMessageTemplates.mockReset().mockResolvedValue({ ok: true, data: { data: [] } });
  mockState.sendOperatorNotification.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.resolveOperatorRecipients.mockReset().mockReturnValue([{ email: 'ops@kairikos.com' }]);
  state.connectionFindMany.mockResolvedValue([]);
  state.connectionUpdate.mockResolvedValue({});
  state.templateUpsert.mockResolvedValue({});
});

describe('syncTemplateStatuses', () => {
  async function run() {
    const { syncTemplateStatuses } = await import('@/lib/whatsapp-health');
    return syncTemplateStatuses(prisma, { now: NOW });
  }

  it('only looks at active WhatsApp connections that have a WABA', async () => {
    await run();
    const where = state.connectionFindMany.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({ channel: 'whatsapp', status: 'active', wabaId: { not: null } }),
    );
  });

  it('mirrors whatever Meta currently says, including a PAUSED template', async () => {
    state.connectionFindMany.mockResolvedValue([CONNECTION]);
    mockState.listMessageTemplates.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { id: 't1', name: 'recall_missed_call', language: 'es', status: 'APPROVED', category: 'UTILITY' },
          // Meta paused this on its own; nothing told us.
          { id: 't2', name: 'recall_review', language: 'es', status: 'PAUSED' },
        ],
      },
    });

    await expect(run()).resolves.toEqual({ connections: 1, templates: 2, failed: 0 });
    const statuses = state.templateUpsert.mock.calls.map((c) => c[0].update.status);
    expect(statuses).toEqual(['APPROVED', 'PAUSED']);
  });

  it('keeps the rejection reason, which is the only thing that tells an operator what to fix', async () => {
    state.connectionFindMany.mockResolvedValue([CONNECTION]);
    mockState.listMessageTemplates.mockResolvedValue({
      ok: true,
      data: { data: [{ name: 'x', language: 'es', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }] },
    });

    await run();
    expect(state.templateUpsert.mock.calls[0][0].update.rejectedReason).toBe('INVALID_FORMAT');
  });

  it('scopes the upsert per connection+name+language, the way Meta scopes a template', async () => {
    state.connectionFindMany.mockResolvedValue([CONNECTION]);
    mockState.listMessageTemplates.mockResolvedValue({
      ok: true,
      data: { data: [{ name: 'recall_missed_call', language: 'es', status: 'APPROVED' }] },
    });

    await run();
    expect(state.templateUpsert.mock.calls[0][0].where).toEqual({
      connectionId_name_languageCode: { connectionId: 'conn_1', name: 'recall_missed_call', languageCode: 'es' },
    });
  });

  it('records the error on the connection when Meta rejects the listing', async () => {
    state.connectionFindMany.mockResolvedValue([CONNECTION]);
    mockState.listMessageTemplates.mockResolvedValue({ ok: false, error: 'invalid token' });

    await expect(run()).resolves.toEqual({ connections: 1, templates: 0, failed: 1 });
    expect(state.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastSyncError: 'invalid token' } }),
    );
  });

  it('survives a key rotation making a token undecryptable, without aborting the sweep', async () => {
    state.connectionFindMany.mockResolvedValue([CONNECTION, { ...CONNECTION, id: 'conn_2' }]);
    mockState.decryptMetaToken.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    mockState.listMessageTemplates.mockResolvedValue({ ok: true, data: { data: [] } });

    await expect(run()).resolves.toEqual({ connections: 2, templates: 0, failed: 1 });
  });
});

describe('warnExpiringTokens', () => {
  async function run() {
    const { warnExpiringTokens } = await import('@/lib/whatsapp-health');
    return warnExpiringTokens(prisma, { now: NOW });
  }

  function connectionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'conn_1',
      clientId: 'client_1',
      channel: 'whatsapp',
      tokenExpiresAt: inDays(3),
      expiryWarnedAt: null,
      displayPhoneNumber: '+34600112233',
      client: { name: 'Juan', companyName: 'Fontanería Aurora' },
      ...overrides,
    };
  }

  it('warns BEFORE the token dies, not after', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow()]);

    await expect(run()).resolves.toEqual({ scanned: 1, expiring: 1, warned: 1, expired: 0 });
    expect(mockState.sendOperatorNotification).toHaveBeenCalled();
    // Still usable, so the connection stays active.
    expect(state.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { expiryWarnedAt: NOW } }),
    );
  });

  it('flips an already-dead token to needs_reconnect — a status nothing has ever written', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow({ tokenExpiresAt: inDays(-1) })]);

    await expect(run()).resolves.toEqual({ scanned: 1, expiring: 0, warned: 0, expired: 1 });
    expect(state.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'needs_reconnect', lastSyncError: 'token_expired' } }),
    );
    // No point emailing about a token that is already gone; the status
    // change is what surfaces it.
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('warns once per token however often the tick runs', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow({ expiryWarnedAt: inDays(-1) })]);

    await expect(run()).resolves.toEqual({ scanned: 1, expiring: 1, warned: 0, expired: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('does NOT consume the warning when the send fails', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow()]);
    mockState.sendOperatorNotification.mockResolvedValue({ ok: false, error: 'resend down' });

    await expect(run()).resolves.toEqual({ scanned: 1, expiring: 1, warned: 0, expired: 0 });
    // Stamping here would silence the retry and the token would die
    // completely unannounced.
    expect(state.connectionUpdate).not.toHaveBeenCalled();
  });

  it('names the client and the number in the alert', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow()]);
    await run();

    const subject = mockState.sendOperatorNotification.mock.calls[0][0].subject as string;
    expect(subject).toContain('Fontanería Aurora');
    expect(subject).toContain('+34600112233');
  });

  it('still reports counts when no operator recipients are configured', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow()]);
    mockState.resolveOperatorRecipients.mockReturnValue([]);

    await expect(run()).resolves.toEqual({ scanned: 1, expiring: 1, warned: 0, expired: 0 });
  });

  it('keeps going when one connection throws', async () => {
    state.connectionFindMany.mockResolvedValue([connectionRow(), connectionRow({ id: 'conn_2' })]);
    state.connectionUpdate.mockRejectedValueOnce(new Error('db blip'));

    await expect(run()).resolves.toEqual({ scanned: 2, expiring: 2, warned: 1, expired: 0 });
  });
});
