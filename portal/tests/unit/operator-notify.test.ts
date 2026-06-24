// =============================================================================
// KAIA-1061 — unit tests for src/lib/operator-notify.ts
//
// Covers the allowlist, recipient resolution, UTC day key, and the
// three template renderers (stuck / execution-failed / escalation).
// The Resend SDK is not exercised here — it is wrapped in a runtime
// `require` inside the helper, so we keep these tests at the level
// of the pure functions. The smoke script
// (`scripts/smoke-notify-operator.ts`) covers the route-level contract.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_KINDS,
  parseKindsAllowlist,
  renderEscalation,
  renderExecutionFailed,
  renderStuck,
  resolveOperatorRecipients,
  utcDayKey,
} from '@/lib/operator-notify';

describe('ALLOWED_KINDS', () => {
  it('exposes the three contract kinds', () => {
    expect([...ALLOWED_KINDS].sort()).toEqual([
      'escalation',
      'execution-failed',
      'stuck',
    ]);
  });
});

describe('parseKindsAllowlist', () => {
  it('returns null when unset (all allowed)', () => {
    expect(parseKindsAllowlist(undefined)).toBeNull();
    expect(parseKindsAllowlist('')).toBeNull();
    expect(parseKindsAllowlist('  ')).toBeNull();
  });

  it('returns the filtered set for a comma-separated env value', () => {
    const set = parseKindsAllowlist('stuck,execution-failed');
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(['execution-failed', 'stuck']);
  });

  it('drops unknown kinds but keeps valid ones', () => {
    const set = parseKindsAllowlist('stuck,random,escalation');
    expect([...set!].sort()).toEqual(['escalation', 'stuck']);
  });

  it('falls back to all-allowed when every token is unknown', () => {
    expect(parseKindsAllowlist('foo,bar')).toBeNull();
  });
});

describe('resolveOperatorRecipients', () => {
  it('returns an empty list when unset', () => {
    expect(resolveOperatorRecipients(undefined)).toEqual([]);
    expect(resolveOperatorRecipients('')).toEqual([]);
  });

  it('parses a single recipient', () => {
    expect(resolveOperatorRecipients('ops@example.com')).toEqual([{ email: 'ops@example.com' }]);
  });

  it('parses multiple recipients and trims whitespace', () => {
    expect(resolveOperatorRecipients('a@x.com , b@x.com')).toEqual([
      { email: 'a@x.com' },
      { email: 'b@x.com' },
    ]);
  });

  it('drops empty entries', () => {
    expect(resolveOperatorRecipients('a@x.com,,b@x.com,')).toEqual([
      { email: 'a@x.com' },
      { email: 'b@x.com' },
    ]);
  });
});

describe('utcDayKey', () => {
  it('returns the YYYY-MM-DD prefix in UTC', () => {
    expect(utcDayKey(new Date('2026-06-12T23:59:59.999Z'))).toBe('2026-06-12');
    expect(utcDayKey(new Date('2026-06-13T00:00:00.000Z'))).toBe('2026-06-13');
    expect(utcDayKey(new Date('2026-01-01T12:00:00.000Z'))).toBe('2026-01-01');
  });
});

describe('renderStuck', () => {
  it('produces a subject that mentions the client, milestone, and hours', () => {
    const r = renderStuck({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      milestone: 'T+3',
      hoursSince: 26,
    });
    expect(r.subject).toContain('Peluquería Aurora');
    expect(r.subject).toContain('T+3');
    expect(r.subject).toContain('26h');
  });

  it('mentions the client, milestone, and hours in the text body', () => {
    const r = renderStuck({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      milestone: 'T+7',
      hoursSince: 48,
    });
    expect(r.text).toContain('Peluquería Aurora');
    expect(r.text).toContain('T+7');
    expect(r.text).toContain('48');
  });

  it('produces HTML with a portal link', () => {
    const r = renderStuck({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      milestone: 'T+3',
      hoursSince: 26,
    });
    expect(r.html).toContain('<a ');
    expect(r.html).toContain('Peluquería Aurora');
  });

  it('escapes HTML in the client name', () => {
    const r = renderStuck({
      clientId: 'cid',
      clientName: '<script>alert(1)</script>',
      milestone: 'T+3',
      hoursSince: 26,
    });
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});

describe('renderExecutionFailed', () => {
  it('includes the workflow name in the subject', () => {
    const r = renderExecutionFailed({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      executionId: 'exec_1',
      workflowName: 'T+0 Onboarding',
      error: 'Resend 5xx',
    });
    expect(r.subject).toContain('T+0 Onboarding');
    expect(r.subject).toContain('Peluquería Aurora');
  });

  it('omits the client name in the subject when not assigned', () => {
    const r = renderExecutionFailed({
      clientId: null,
      clientName: null,
      executionId: 'exec_1',
      workflowName: 'T+3',
      error: 'timeout',
    });
    expect(r.subject).not.toContain('undefined');
    expect(r.subject).toContain('T+3');
  });

  it('includes the error message and a portal link in the body', () => {
    const r = renderExecutionFailed({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      executionId: 'exec_1',
      workflowName: 'T+0 Onboarding',
      error: 'Resend 5xx',
    });
    expect(r.text).toContain('Resend 5xx');
    expect(r.html).toContain('Resend 5xx');
    expect(r.html).toContain('<a ');
  });
});

describe('renderEscalation', () => {
  it('includes the client name and reason in the subject', () => {
    const r = renderEscalation({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      reason: 'No response in 14d',
    });
    expect(r.subject).toContain('Peluquería Aurora');
  });

  it('includes the status and reason in the body when provided', () => {
    const r = renderEscalation({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      reason: 'No response in 14d',
      status: 'overdue',
    });
    expect(r.text).toContain('overdue');
    expect(r.text).toContain('No response in 14d');
    expect(r.html).toContain('overdue');
  });

  it('omits status section when status is null', () => {
    const r = renderEscalation({
      clientId: 'cid',
      clientName: 'Peluquería Aurora',
      reason: 'No response in 14d',
      status: null,
    });
    expect(r.text).not.toContain('Estado actual');
    expect(r.html).not.toContain('Estado actual');
  });
});
