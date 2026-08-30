// =============================================================================
// WP-XX — unit tests for GET /api/cron/recall-tick.
//
// Two properties matter here beyond auth: every job must be ISOLATED (one
// throwing must not cost the others their turn), and the endpoint must
// stay useful when telephony is unconfigured rather than failing whole.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  sweepPendingTranscriptions: vi.fn(),
  purgeExpiredRecordings: vi.fn(),
  notifyStuckOnboardings: vi.fn(),
  sweepPendingNotifications: vi.fn(),
  sendDailyDigests: vi.fn(),
  sendMonthlyReports: vi.fn(),
  rollUpUsage: vi.fn(),
  sweepReviewReminders: vi.fn(),
  syncTemplateStatuses: vi.fn(),
  warnExpiringTokens: vi.fn(),
  advanceSubscriptionsWithApprovedTemplates: vi.fn(),
  resolveActiveTwilioCredentials: vi.fn(),
}));

vi.mock('@/lib/recall-transcription', () => ({
  sweepPendingTranscriptions: (...a: unknown[]) => mockState.sweepPendingTranscriptions(...a),
}));
vi.mock('@/lib/recall-retention', () => ({
  purgeExpiredRecordings: (...a: unknown[]) => mockState.purgeExpiredRecordings(...a),
  RECORDING_RETENTION_DAYS: 30,
}));
vi.mock('@/lib/recall-stuck-alerts', () => ({
  notifyStuckOnboardings: (...a: unknown[]) => mockState.notifyStuckOnboardings(...a),
}));
vi.mock('@/lib/recall-reports', () => ({
  sendMonthlyReports: (...a: unknown[]) => mockState.sendMonthlyReports(...a),
  rollUpUsage: (...a: unknown[]) => mockState.rollUpUsage(...a),
}));
vi.mock('@/lib/recall-reviews', () => ({
  sendDailyDigests: (...a: unknown[]) => mockState.sendDailyDigests(...a),
  sweepReviewReminders: (...a: unknown[]) => mockState.sweepReviewReminders(...a),
}));
vi.mock('@/lib/recall-messaging', () => ({
  sweepPendingNotifications: (...a: unknown[]) => mockState.sweepPendingNotifications(...a),
}));
vi.mock('@/lib/whatsapp-health', () => ({
  syncTemplateStatuses: (...a: unknown[]) => mockState.syncTemplateStatuses(...a),
  warnExpiringTokens: (...a: unknown[]) => mockState.warnExpiringTokens(...a),
}));
vi.mock('@/lib/recall-templates', () => ({
  advanceSubscriptionsWithApprovedTemplates: (...a: unknown[]) => mockState.advanceSubscriptionsWithApprovedTemplates(...a),
}));
vi.mock('@/lib/twilio-credentials', () => ({
  resolveActiveTwilioCredentials: (...a: unknown[]) => mockState.resolveActiveTwilioCredentials(...a),
}));
vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: true, prisma: {} }));

const SECRET = 'cron_secret_value';

function makeRequest(auth: string | null = `Bearer ${SECRET}`) {
  return { headers: new Headers(auth ? { authorization: auth } : {}) } as unknown as NextRequest;
}

async function get(req: NextRequest) {
  const { GET } = await import('@/app/api/cron/recall-tick/route');
  return GET(req);
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mockState.resolveActiveTwilioCredentials.mockReset().mockResolvedValue({ accountSid: 'AC1', authToken: 'tok' });
  mockState.sweepPendingTranscriptions.mockReset().mockResolvedValue({ scanned: 0, transcribed: 0, failed: 0 });
  mockState.purgeExpiredRecordings.mockReset().mockResolvedValue({ scanned: 0, purged: 0, failed: 0 });
  mockState.notifyStuckOnboardings.mockReset().mockResolvedValue({ scanned: 0, stuck: 0, notified: 0, deduped: 0, failed: 0 });
  mockState.sendMonthlyReports
    .mockReset()
    .mockResolvedValue({ scanned: 0, sent: 0, skippedEmpty: 0, failed: 0 });
  mockState.rollUpUsage.mockReset().mockResolvedValue({ scanned: 0, updated: 0, alerted: 0, failed: 0 });
  mockState.sendDailyDigests
    .mockReset()
    .mockResolvedValue({ scanned: 0, sent: 0, skippedNoCalls: 0, failed: 0 });
  mockState.sweepReviewReminders.mockReset().mockResolvedValue({ scanned: 0, reminded: 0, failed: 0 });
  mockState.sweepPendingNotifications.mockReset().mockResolvedValue({
    callersScanned: 0, callersSent: 0, callersSkipped: 0, callersFailed: 0,
    ownersScanned: 0, ownersSent: 0, ownersFailed: 0,
  });
  mockState.syncTemplateStatuses.mockReset().mockResolvedValue({ connections: 0, templates: 0, failed: 0 });
  mockState.warnExpiringTokens.mockReset().mockResolvedValue({ scanned: 0, expiring: 0, warned: 0, expired: 0 });
  mockState.advanceSubscriptionsWithApprovedTemplates.mockReset().mockResolvedValue({ advanced: 0 });
});

describe('GET /api/cron/recall-tick', () => {
  it('401s without the bearer secret', async () => {
    expect((await get(makeRequest(null))).status).toBe(401);
    expect((await get(makeRequest('Bearer wrong'))).status).toBe(401);
    expect(mockState.purgeExpiredRecordings).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is unset — an unset secret must not open the door', async () => {
    delete process.env.CRON_SECRET;
    expect((await get(makeRequest('Bearer '))).status).toBe(401);
  });

  it('runs every job on a valid tick', async () => {
    const res = await get(makeRequest());
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(Object.keys(body.jobs)).toEqual([
      'purgeRecordings',
      'transcriptions',
      'notifications',
      'dailyDigests',
      'reviewReminders',
      'monthlyReports',
      'usageRollup',
      'stuckAlerts',
      'tokenExpiry',
      'templateSync',
      'templateApproval',
    ]);
    expect(mockState.purgeExpiredRecordings).toHaveBeenCalled();
    expect(mockState.sweepPendingTranscriptions).toHaveBeenCalled();
    expect(mockState.sweepPendingNotifications).toHaveBeenCalled();
    expect(mockState.sendDailyDigests).toHaveBeenCalled();
    expect(mockState.sweepReviewReminders).toHaveBeenCalled();
    expect(mockState.sendMonthlyReports).toHaveBeenCalled();
    expect(mockState.rollUpUsage).toHaveBeenCalled();
    expect(mockState.notifyStuckOnboardings).toHaveBeenCalled();
    expect(mockState.warnExpiringTokens).toHaveBeenCalled();
    expect(mockState.syncTemplateStatuses).toHaveBeenCalled();
    expect(mockState.advanceSubscriptionsWithApprovedTemplates).toHaveBeenCalled();
  });

  it('runs the template approval check AFTER the template sync, same tick', async () => {
    const order: string[] = [];
    mockState.syncTemplateStatuses.mockImplementation(async () => {
      order.push('sync');
      return { connections: 0, templates: 0, failed: 0 };
    });
    mockState.advanceSubscriptionsWithApprovedTemplates.mockImplementation(async () => {
      order.push('approve');
      return { advanced: 0 };
    });

    await get(makeRequest());
    expect(order).toEqual(['sync', 'approve']);
  });

  it('runs the Meta health jobs, which need no telephony, even when Twilio is unconfigured', async () => {
    mockState.resolveActiveTwilioCredentials.mockResolvedValueOnce(null);
    await get(makeRequest());
    // A token quietly expiring is a silent outage; it must not be
    // conditional on an unrelated integration being set up.
    expect(mockState.warnExpiringTokens).toHaveBeenCalled();
    expect(mockState.syncTemplateStatuses).toHaveBeenCalled();
  });

  it('runs retention FIRST — it is the job with a legal deadline attached', async () => {
    const order: string[] = [];
    mockState.purgeExpiredRecordings.mockImplementation(async () => {
      order.push('purge');
      return {};
    });
    mockState.sweepPendingTranscriptions.mockImplementation(async () => {
      order.push('transcribe');
      return {};
    });

    await get(makeRequest());
    expect(order[0]).toBe('purge');
  });

  it('skips the purge but still runs the rest when Twilio is unconfigured', async () => {
    mockState.resolveActiveTwilioCredentials.mockResolvedValueOnce(null);
    const body = await (await get(makeRequest())).clone().json();

    expect(body.jobs.purgeRecordings).toEqual({ skipped: 'twilio_not_configured' });
    // The stuck alerts need no telephony at all and must still fire.
    expect(mockState.notifyStuckOnboardings).toHaveBeenCalled();
  });

  it('isolates a throwing job so the others still run', async () => {
    mockState.purgeExpiredRecordings.mockRejectedValue(new Error('twilio exploded'));

    const res = await get(makeRequest());
    const body = await res.clone().json();

    // A failing job reports its error in the payload; it does not take
    // the tick down with it.
    expect(res.status).toBe(200);
    expect(body.jobs.purgeRecordings).toEqual({ ok: false, error: 'twilio exploded' });
    expect(mockState.sweepPendingTranscriptions).toHaveBeenCalled();
    expect(mockState.notifyStuckOnboardings).toHaveBeenCalled();
  });

  it('returns each job result as telemetry the scheduler can log', async () => {
    mockState.sweepPendingTranscriptions.mockResolvedValue({ scanned: 3, transcribed: 2, failed: 1 });
    const body = await (await get(makeRequest())).clone().json();
    expect(body.jobs.transcriptions).toEqual({ ok: true, result: { scanned: 3, transcribed: 2, failed: 1 } });
  });
});
