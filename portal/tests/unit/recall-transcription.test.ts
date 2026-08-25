// =============================================================================
// WP-XX — unit tests for transcription + lead creation (Fase 4).
//
// The Whisper client is mocked; its own fetch-level behaviour is covered
// in whisper.test.ts. What matters here is the orchestration: idempotency
// (the inline path and the sweep race each other by design), which calls
// do and do not become Leads, and that one bad row never aborts a sweep.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  transcribeRecording: vi.fn(),
  isWhisperConfigured: vi.fn(),
}));

vi.mock('@/lib/whisper', () => ({
  transcribeRecording: (...a: unknown[]) => mockState.transcribeRecording(...a),
  isWhisperConfigured: () => mockState.isWhisperConfigured(),
}));

const state = {
  callEventFindUnique: vi.fn(),
  callEventFindMany: vi.fn(),
  callEventUpdate: vi.fn(),
  leadCreate: vi.fn(),
  leadAuditCreate: vi.fn(),
};

const tx = {
  callEvent: { update: (...a: unknown[]) => state.callEventUpdate(...a) },
  lead: { create: (...a: unknown[]) => state.leadCreate(...a) },
  leadAudit: { create: (...a: unknown[]) => state.leadAuditCreate(...a) },
};

const prisma = {
  $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  callEvent: {
    findUnique: (...a: unknown[]) => state.callEventFindUnique(...a),
    findMany: (...a: unknown[]) => state.callEventFindMany(...a),
    update: (...a: unknown[]) => state.callEventUpdate(...a),
  },
} as unknown as PrismaClient;

const RECORDED = {
  id: 'ce_1',
  clientId: 'client_1',
  tenantId: 'tenant_1',
  fromNumber: '+34600111222',
  recordingUrl: 'https://api.twilio.com/rec/RE1',
  transcript: null,
  leadId: null,
  outcome: 'recorded',
};

beforeEach(async () => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.transcribeRecording.mockReset();
  mockState.isWhisperConfigured.mockReset().mockReturnValue(true);
  state.callEventUpdate.mockResolvedValue({});
  state.leadCreate.mockResolvedValue({ id: 'lead_1', clientId: 'client_1', tenantId: 'tenant_1' });
  state.leadAuditCreate.mockResolvedValue({});
});

describe('summarise', () => {
  it('leaves a short transcript alone but collapses whitespace', async () => {
    const { summarise } = await import('@/lib/recall-transcription');
    expect(summarise('  tengo   una fuga\nen el baño  ')).toBe('tengo una fuga en el baño');
  });

  it('truncates on a word boundary rather than mid-word', async () => {
    const { summarise } = await import('@/lib/recall-transcription');
    const long = 'palabra '.repeat(60);
    const out = summarise(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('palabr…');
  });
});

describe('transcribeCallEvent', () => {
  async function run(id = 'ce_1') {
    const { transcribeCallEvent } = await import('@/lib/recall-transcription');
    return transcribeCallEvent(prisma, id);
  }

  it('skips when Whisper is not configured, without touching the row', async () => {
    mockState.isWhisperConfigured.mockReturnValue(false);
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(state.callEventFindUnique).not.toHaveBeenCalled();
  });

  it('skips an unknown call, one with no recording, and one already transcribed', async () => {
    state.callEventFindUnique.mockResolvedValueOnce(null);
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'not_found' });

    state.callEventFindUnique.mockResolvedValueOnce({ ...RECORDED, recordingUrl: null });
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'no_recording' });

    // Idempotency: the sweep racing the inline path must be a no-op.
    state.callEventFindUnique.mockResolvedValueOnce({ ...RECORDED, transcript: 'ya está' });
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'already_done' });
    expect(mockState.transcribeRecording).not.toHaveBeenCalled();
  });

  it('transcribes and creates a lead with the phone channel and a summary', async () => {
    state.callEventFindUnique.mockResolvedValue(RECORDED);
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: 'Tengo una fuga en el baño y pasa al vecino' });

    await expect(run()).resolves.toEqual({ status: 'transcribed', leadId: 'lead_1' });

    expect(state.leadCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: 'client_1',
        contactPhone: '+34600111222',
        channel: 'phone',
        summary: 'Tengo una fuga en el baño y pasa al vecino',
      }),
    });
    expect(state.leadAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'created', statusAfter: 'nuevo', actorId: 'system:recall' }),
    });
  });

  it('writes the full transcript to the call but only a summary to the lead', async () => {
    const long = 'Buenas, mira, te llamo porque '.repeat(30);
    state.callEventFindUnique.mockResolvedValue(RECORDED);
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: long });

    await run();

    const transcriptWrite = state.callEventUpdate.mock.calls.find((c) => c[0].data.transcript);
    expect(transcriptWrite[0].data.transcript).toBe(long);
    expect(state.leadCreate.mock.calls[0][0].data.summary.length).toBeLessThan(long.length);
  });

  it('does NOT create a lead for a withheld caller — nobody to ring back', async () => {
    state.callEventFindUnique.mockResolvedValue({ ...RECORDED, outcome: 'withheld', fromNumber: null });
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: 'quiero un presupuesto' });

    await expect(run()).resolves.toEqual({ status: 'transcribed', leadId: null });
    // The message is still readable on the CallEvent; it just does not
    // enter a sales pipeline that would nag the owner to call back.
    expect(state.leadCreate).not.toHaveBeenCalled();
    expect(state.callEventUpdate).toHaveBeenCalled();
  });

  it('does NOT create a second lead for a call that already has one', async () => {
    state.callEventFindUnique.mockResolvedValue({ ...RECORDED, leadId: 'lead_existing' });
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: 'hola' });

    await expect(run()).resolves.toEqual({ status: 'transcribed', leadId: null });
    expect(state.leadCreate).not.toHaveBeenCalled();
  });

  it('records the failure on the row and reports whether a retry is worthwhile', async () => {
    state.callEventFindUnique.mockResolvedValue(RECORDED);
    mockState.transcribeRecording.mockResolvedValue({ ok: false, error: 'whisper_503', retryable: true });

    await expect(run()).resolves.toEqual({ status: 'failed', error: 'whisper_503', retryable: true });
    expect(state.callEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { transcriptionError: 'whisper_503' } }),
    );
    expect(state.leadCreate).not.toHaveBeenCalled();
  });

  it('clears a previous error once a retry succeeds', async () => {
    state.callEventFindUnique.mockResolvedValue(RECORDED);
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: 'ya se oye bien' });

    await run();
    const write = state.callEventUpdate.mock.calls.find((c) => c[0].data.transcript);
    expect(write[0].data.transcriptionError).toBeNull();
  });
});

describe('sweepPendingTranscriptions', () => {
  async function sweep(limit?: number) {
    const { sweepPendingTranscriptions } = await import('@/lib/recall-transcription');
    return sweepPendingTranscriptions(prisma, limit ? { limit } : {});
  }

  it('does nothing when Whisper is unconfigured', async () => {
    mockState.isWhisperConfigured.mockReturnValue(false);
    await expect(sweep()).resolves.toEqual({ scanned: 0, transcribed: 0, failed: 0 });
  });

  it('only picks up recorded calls with audio still present, oldest first', async () => {
    state.callEventFindMany.mockResolvedValue([]);
    await sweep();

    const arg = state.callEventFindMany.mock.calls[0][0];
    expect(arg.where).toEqual(
      expect.objectContaining({
        outcome: 'recorded',
        transcript: null,
        // Never resurrect a purged recording: the audio is gone.
        recordingDeletedAt: null,
      }),
    );
    expect(arg.orderBy).toEqual({ startedAt: 'asc' });
  });

  it('bounds the batch so one sweep cannot exceed the scheduler budget', async () => {
    state.callEventFindMany.mockResolvedValue([]);
    await sweep(5);
    expect(state.callEventFindMany.mock.calls[0][0].take).toBe(5);
  });

  it('counts successes and failures separately', async () => {
    state.callEventFindMany.mockResolvedValue([{ id: 'ce_1' }, { id: 'ce_2' }]);
    state.callEventFindUnique.mockResolvedValue(RECORDED);
    mockState.transcribeRecording
      .mockResolvedValueOnce({ ok: true, text: 'primero' })
      .mockResolvedValueOnce({ ok: false, error: 'timeout', retryable: true });

    await expect(sweep()).resolves.toEqual({ scanned: 2, transcribed: 1, failed: 1 });
  });

  it('keeps going when one row throws — a bad row must not abort the sweep', async () => {
    state.callEventFindMany.mockResolvedValue([{ id: 'ce_1' }, { id: 'ce_2' }]);
    state.callEventFindUnique
      .mockRejectedValueOnce(new Error('row exploded'))
      .mockResolvedValueOnce(RECORDED);
    mockState.transcribeRecording.mockResolvedValue({ ok: true, text: 'segundo' });

    await expect(sweep()).resolves.toEqual({ scanned: 2, transcribed: 1, failed: 1 });
  });
});
