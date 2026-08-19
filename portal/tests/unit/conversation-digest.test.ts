// =============================================================================
// Canales Fase 7 — unit tests for src/lib/conversation-digest.ts.
//
// Covers: due-check logic for both presets (custom_interval and the
// morning/noon/evening slot boundaries), the zero-conversations skip
// (schedule still advances so the cron doesn't retry every tick until
// the next slot), deterministic aggregate counts vs. AI-generated
// summary/highlights, graceful degradation when the AI call fails or is
// skipped, best-effort email that never blocks digest persistence, and
// per-schedule error isolation in the sweep.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  conversationFindMany: vi.fn(),
  digestCreate: vi.fn(),
  scheduleUpdate: vi.fn(),
  scheduleFindMany: vi.fn(),
  clientFindUnique: vi.fn(),
  generateConversationDigest: vi.fn(),
  sendConversationDigestEmail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotConversation: { findMany: (...args: unknown[]) => mockState.conversationFindMany(...args) },
    conversationDigest: { create: (...args: unknown[]) => mockState.digestCreate(...args) },
    conversationDigestSchedule: {
      update: (...args: unknown[]) => mockState.scheduleUpdate(...args),
      findMany: (...args: unknown[]) => mockState.scheduleFindMany(...args),
    },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.clientFindUnique(...args) },
  },
}));

vi.mock('@/lib/conversation-summary-ai', () => ({
  generateConversationDigest: (...args: unknown[]) => mockState.generateConversationDigest(...args),
}));

vi.mock('@/lib/conversation-digest-email', () => ({
  sendConversationDigestEmail: (...args: unknown[]) => mockState.sendConversationDigestEmail(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isDigestDue, mostRecentSlotBoundary, generateDigestForSchedule, generateDueDigests } from '@/lib/conversation-digest';

function baseSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    enabled: true,
    preset: 'morning_noon_evening',
    intervalHours: null,
    timezone: 'UTC',
    lastGeneratedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockState.conversationFindMany.mockReset().mockResolvedValue([]);
  mockState.digestCreate.mockReset().mockResolvedValue({});
  mockState.scheduleUpdate.mockReset().mockResolvedValue({});
  mockState.scheduleFindMany.mockReset();
  mockState.clientFindUnique.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly', email: 'orly@example.com' });
  mockState.generateConversationDigest.mockReset().mockResolvedValue({ ok: true, summaryText: 'Resumen IA', highlights: ['Atender a Ana'] });
  mockState.sendConversationDigestEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.logError.mockReset();
});

describe('mostRecentSlotBoundary', () => {
  it('finds the most recent slot within the same day', () => {
    const now = new Date('2026-08-19T10:00:00Z');
    const boundary = mostRecentSlotBoundary(now, [9, 13, 18], 'UTC');
    expect(boundary.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });

  it('falls back to the previous day\'s last slot when before the first slot today', () => {
    const now = new Date('2026-08-19T05:00:00Z');
    const boundary = mostRecentSlotBoundary(now, [9, 13, 18], 'UTC');
    expect(boundary.toISOString()).toBe('2026-08-18T18:00:00.000Z');
  });
});

describe('isDigestDue', () => {
  it('is never due when disabled, regardless of preset or lastGeneratedAt', () => {
    expect(isDigestDue(baseSchedule({ enabled: false, lastGeneratedAt: null }), new Date())).toBe(false);
  });

  it('custom_interval: due when never generated', () => {
    const schedule = baseSchedule({ preset: 'custom_interval', intervalHours: 4, lastGeneratedAt: null });
    expect(isDigestDue(schedule, new Date())).toBe(true);
  });

  it('custom_interval: not due within the configured interval', () => {
    const now = new Date('2026-08-19T12:00:00Z');
    const schedule = baseSchedule({ preset: 'custom_interval', intervalHours: 4, lastGeneratedAt: new Date('2026-08-19T10:00:00Z') });
    expect(isDigestDue(schedule, now)).toBe(false);
  });

  it('custom_interval: due once the configured interval has elapsed', () => {
    const now = new Date('2026-08-19T14:01:00Z');
    const schedule = baseSchedule({ preset: 'custom_interval', intervalHours: 4, lastGeneratedAt: new Date('2026-08-19T10:00:00Z') });
    expect(isDigestDue(schedule, now)).toBe(true);
  });

  it('morning_noon_evening: due when never generated', () => {
    const schedule = baseSchedule({ lastGeneratedAt: null });
    expect(isDigestDue(schedule, new Date('2026-08-19T10:00:00Z'))).toBe(true);
  });

  it('morning_noon_evening: not due when the last digest already covers the most recent slot', () => {
    const now = new Date('2026-08-19T10:00:00Z');
    const schedule = baseSchedule({ lastGeneratedAt: new Date('2026-08-19T09:30:00Z') });
    expect(isDigestDue(schedule, now)).toBe(false);
  });

  it('morning_noon_evening: due once a new slot boundary has passed since the last digest', () => {
    const now = new Date('2026-08-19T13:05:00Z');
    const schedule = baseSchedule({ lastGeneratedAt: new Date('2026-08-19T09:30:00Z') });
    expect(isDigestDue(schedule, now)).toBe(true);
  });
});

describe('generateDigestForSchedule', () => {
  it('does nothing and queries nothing when not due', async () => {
    const now = new Date('2026-08-19T10:00:00Z');
    const schedule = baseSchedule({ lastGeneratedAt: new Date('2026-08-19T09:30:00Z') });
    const result = await generateDigestForSchedule(schedule, now);
    expect(result).toEqual({ generated: false, reason: 'not_due' });
    expect(mockState.conversationFindMany).not.toHaveBeenCalled();
  });

  it('advances lastGeneratedAt but persists nothing when the window has zero conversations', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([]);
    const now = new Date('2026-08-19T10:00:00Z');
    const result = await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), now);
    expect(result).toEqual({ generated: false, reason: 'no_conversations' });
    expect(mockState.digestCreate).not.toHaveBeenCalled();
    expect(mockState.scheduleUpdate).toHaveBeenCalledWith({ where: { id: 'sched_1' }, data: { lastGeneratedAt: now } });
    expect(mockState.generateConversationDigest).not.toHaveBeenCalled();
    expect(mockState.sendConversationDigestEmail).not.toHaveBeenCalled();
  });

  it('computes deterministic aggregate counts from outcome, independent of the AI call', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([
      { startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null },
      { startedAt: new Date(), outcome: 'escalated', duration: 120, transcript: null },
      { startedAt: new Date(), outcome: 'escalated', duration: 90, transcript: null },
      { startedAt: new Date(), outcome: 'fallback', duration: 30, transcript: null },
    ]);
    const now = new Date('2026-08-19T10:00:00Z');
    const result = await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), now);
    expect(result).toEqual({ generated: true });
    expect(mockState.digestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalConversations: 4,
          escalatedCount: 2,
          fallbackCount: 1,
          summaryText: 'Resumen IA',
          highlights: ['Atender a Ana'],
        }),
      }),
    );
  });

  it('falls back to a degraded summaryText and logs a warning when the AI call fails, but still persists the digest', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null }]);
    mockState.generateConversationDigest.mockResolvedValueOnce({ ok: false, error: 'anthropic_api_error:500:' });
    const result = await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), new Date('2026-08-19T10:00:00Z'));
    expect(result).toEqual({ generated: true });
    expect(mockState.digestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ highlights: [] }) }),
    );
    const [, data] = [null, mockState.digestCreate.mock.calls[0][0].data];
    expect(data.summaryText).toMatch(/no se pudo generar/i);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('falls back to a degraded summaryText without logging an error when the AI is simply unconfigured', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null }]);
    mockState.generateConversationDigest.mockResolvedValueOnce({ ok: true, skipped: true, reason: 'no_api_key' });
    const result = await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), new Date('2026-08-19T10:00:00Z'));
    expect(result).toEqual({ generated: true });
    expect(mockState.logError).not.toHaveBeenCalled();
  });

  it('sends a best-effort email to the client using the persisted counts', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'escalated', duration: 60, transcript: null }]);
    await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), new Date('2026-08-19T10:00:00Z'));
    expect(mockState.sendConversationDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'orly@example.com', totalConversations: 1, escalatedCount: 1 }),
    );
  });

  it('never sends an email when the client has no email on file', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null }]);
    mockState.clientFindUnique.mockResolvedValueOnce({ companyName: 'X', name: 'X', email: null });
    await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), new Date('2026-08-19T10:00:00Z'));
    expect(mockState.sendConversationDigestEmail).not.toHaveBeenCalled();
  });

  it('a failing email send never throws or blocks the digest from being reported as generated', async () => {
    mockState.conversationFindMany.mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null }]);
    mockState.sendConversationDigestEmail.mockRejectedValueOnce(new Error('resend down'));
    const result = await generateDigestForSchedule(baseSchedule({ lastGeneratedAt: null }), new Date('2026-08-19T10:00:00Z'));
    expect(result).toEqual({ generated: true });
  });
});

describe('generateDueDigests', () => {
  it('only sweeps enabled schedules and isolates a per-client failure from the rest', async () => {
    mockState.scheduleFindMany.mockResolvedValueOnce([
      baseSchedule({ id: 'due_1', clientId: 'c1', lastGeneratedAt: null }),
      baseSchedule({ id: 'fails', clientId: 'c2', lastGeneratedAt: null }),
    ]);
    mockState.conversationFindMany
      .mockResolvedValueOnce([{ startedAt: new Date(), outcome: 'resolved', duration: 60, transcript: null }])
      .mockRejectedValueOnce(new Error('db down'));

    const result = await generateDueDigests();
    expect(result).toEqual({ swept: 2, generated: 1 });
    expect(mockState.logError).toHaveBeenCalledWith('conversation_digest.sweep_failed', expect.any(Error), expect.anything());
  });
});
