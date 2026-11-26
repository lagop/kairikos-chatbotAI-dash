// =============================================================================
// GET /api/cron/retention-purge — la ruta solo cablea autenticación y el
// borrado (que tiene su propio test, retention-purge.test.ts). Lo que se
// guarda aquí es que un fallo NO responda 200: si el borrado deja de correr,
// la política de privacidad deja de cumplirse, y eso tiene que salir como
// FAILED en el log del scheduler, no como un OK más.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  runRetentionPurge: vi.fn(),
  runChatRetention: vi.fn(),
  runClientDataExits: vi.fn(),
  runProcessorDataRetention: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {},
}));

vi.mock('@/lib/retention-purge', () => ({
  runRetentionPurge: (...args: unknown[]) => mockState.runRetentionPurge(...args),
}));

vi.mock('@/lib/chat-retention', () => ({
  runChatRetention: (...args: unknown[]) => mockState.runChatRetention(...args),
}));

vi.mock('@/lib/client-data-exit-auto', () => ({
  runClientDataExits: (...args: unknown[]) => mockState.runClientDataExits(...args),
}));

vi.mock('@/lib/processor-retention', () => ({
  runProcessorDataRetention: (...args: unknown[]) => mockState.runProcessorDataRetention(...args),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

const COUNTS = {
  calculatorLeadsDeleted: 1,
  draftRequestsDeleted: 0,
  premiumQuotesDeleted: 0,
  ownProspectsDeleted: 0,
  ownProspectsMinimized: 2,
};

const CHAT = {
  mode: 'dry_run',
  conversations: 3,
  digests: 1,
  chatbots: 1,
  truncated: false,
  shortRetentionIgnored: 0,
  operatorNotified: false,
};

const PROCESSOR = { webhookPayloadsCleared: 2, webhookDeliveriesExpired: 1, outboundNumbersCleared: 3 };

const EXITS = { clients: 1, notified: 1, purged: 0, problems: 0, operatorAlerts: 0, truncated: false };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.runRetentionPurge.mockReset().mockResolvedValue(COUNTS);
  mockState.runChatRetention.mockReset().mockResolvedValue(CHAT);
  mockState.runClientDataExits.mockReset().mockResolvedValue(EXITS);
  mockState.runProcessorDataRetention.mockReset().mockResolvedValue(PROCESSOR);
  process.env.CRON_SECRET = 'test_cron_secret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/retention-purge', () => {
  it('401 sin el secreto, y no borra nada', async () => {
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer otro' }));
    expect(res.status).toBe(401);
    expect(mockState.runRetentionPurge).not.toHaveBeenCalled();
    expect(mockState.runChatRetention).not.toHaveBeenCalled();
    expect(mockState.runClientDataExits).not.toHaveBeenCalled();
    expect(mockState.runProcessorDataRetention).not.toHaveBeenCalled();
  });

  it('503 sin base de datos', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(503);
  });

  it('devuelve el recuento, que es lo que queda en el log del scheduler', async () => {
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...COUNTS, chat: CHAT, processor: PROCESSOR, exits: EXITS });
  });

  it('la retención del chat también: si falla, 500', async () => {
    mockState.runChatRetention.mockRejectedValue(new Error('chat caído'));
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'chat caído' });
  });

  it('la baja automática de datos también: si falla, 500', async () => {
    mockState.runClientDataExits.mockRejectedValue(new Error('bajas caídas'));
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'bajas caídas' });
  });

  it('los plazos de los envíos al CRM y de los números también: si fallan, 500', async () => {
    mockState.runProcessorDataRetention.mockRejectedValue(new Error('plazos caídos'));
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'plazos caídos' });
  });

  it('un fallo responde 500, no un 200 con ok:false', async () => {
    mockState.runRetentionPurge.mockRejectedValue(new Error('db caída'));
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'db caída' });
  });
});
