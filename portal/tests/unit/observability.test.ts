// =============================================================================
// WP-26 — unit tests for src/lib/observability.ts (logError()).
//
// The function's whole job is "never silent, always structured" — these
// tests assert on the actual console.error/console.warn call shape
// (valid JSON, right fields) rather than just "it didn't throw".
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logError } from '@/lib/observability';

describe('logError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('defaults to console.error with level "error"', () => {
    logError('test.scope', new Error('boom'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe('error');
    expect(entry.scope).toBe('test.scope');
    expect(entry.message).toBe('boom');
  });

  it('uses console.warn when severity is "warn"', () => {
    logError('test.scope', new Error('degraded'), {}, 'warn');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const entry = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe('warn');
  });

  it('captures the stack trace for a real Error', () => {
    const err = new Error('with stack');
    logError('test.scope', err);
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.stack).toContain('Error: with stack');
  });

  it('handles a non-Error thrown value without crashing', () => {
    logError('test.scope', 'a plain string was thrown');
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.message).toBe('a plain string was thrown');
    expect(entry.stack).toBeUndefined();
  });

  it('spreads structured context fields into the log entry', () => {
    logError('dashboard.prisma_fetch', new Error('x'), {
      route: '/portal/dashboard',
      clientId: 'client_123',
      clientEmail: 'a@b.com',
    });
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.route).toBe('/portal/dashboard');
    expect(entry.clientId).toBe('client_123');
    expect(entry.clientEmail).toBe('a@b.com');
  });

  it('always includes a timestamp', () => {
    logError('test.scope', new Error('x'));
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
    expect(entry.timestamp).toBe(new Date(entry.timestamp).toISOString());
  });

  it('produces valid, single-line JSON (greppable, log-drain-safe)', () => {
    logError('test.scope', new Error('multi\nline\nmessage'), { note: 'has "quotes" too' });
    const raw = errorSpy.mock.calls[0][0] as string;
    expect(raw.split('\n')).toHaveLength(1);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
