// =============================================================================
// WP-XX — unit tests for src/lib/recall.ts, the transition predicates for
// the missed-call recovery product. Same style as web-quotes-lib.test.ts:
// pure functions, every boundary of every predicate.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  RECALL_STATUSES,
  isRecallStatus,
  isOnboarding,
  isLive,
  nextOnboardingStatus,
  canAdvanceTo,
  canBindMetaConnection,
  canBindVirtualNumber,
  canBindGoogleConnection,
  canRecordGreeting,
  canPause,
  canResume,
  canCancel,
  stuckThresholdDays,
  isStuck,
} from '@/lib/recall';

describe('isRecallStatus', () => {
  it.each(RECALL_STATUSES)('accepts the known status %s', (status) => {
    expect(isRecallStatus(status)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isRecallStatus('live')).toBe(false);
    expect(isRecallStatus('')).toBe(false);
    expect(isRecallStatus('ACTIVE')).toBe(false);
  });
});

describe('the onboarding sequence', () => {
  it('walks the full happy path one step at a time and then stops', () => {
    const walked: string[] = ['paid'];
    let current: string | null = 'paid';
    while (current) {
      current = nextOnboardingStatus(current);
      if (current) walked.push(current);
    }
    expect(walked).toEqual([
      'paid',
      'contract_signed',
      'meta_connected',
      'number_assigned',
      'templates_approved',
      'forwarding_pending',
      'forwarding_verified',
      'active',
    ]);
  });

  it('has no next step from active', () => {
    expect(nextOnboardingStatus('active')).toBeNull();
  });

  it('has no next step from a side exit or an unknown status', () => {
    expect(nextOnboardingStatus('paused')).toBeNull();
    expect(nextOnboardingStatus('cancelled')).toBeNull();
    expect(nextOnboardingStatus('nonsense')).toBeNull();
  });

  it('canAdvanceTo only allows the single legal forward step', () => {
    expect(canAdvanceTo('paid', 'contract_signed')).toBe(true);
    // Skipping a step is not allowed, even though it is "forward".
    expect(canAdvanceTo('paid', 'meta_connected')).toBe(false);
    // Going backwards is not allowed.
    expect(canAdvanceTo('meta_connected', 'contract_signed')).toBe(false);
    // Nor is standing still.
    expect(canAdvanceTo('paid', 'paid')).toBe(false);
  });
});

describe('isOnboarding / isLive', () => {
  it('treats every pre-active step as onboarding', () => {
    for (const status of [
      'paid',
      'contract_signed',
      'meta_connected',
      'number_assigned',
      'templates_approved',
      'forwarding_pending',
      'forwarding_verified',
    ]) {
      expect(isOnboarding(status)).toBe(true);
    }
  });

  it('does not treat active or the side exits as onboarding', () => {
    expect(isOnboarding('active')).toBe(false);
    expect(isOnboarding('paused')).toBe(false);
    expect(isOnboarding('cancelled')).toBe(false);
  });

  it('isLive is true only for active — paying is a different question', () => {
    expect(isLive('active')).toBe(true);
    expect(isLive('forwarding_verified')).toBe(false);
    expect(isLive('paused')).toBe(false);
  });
});

describe('resource-binding gates', () => {
  it('binds a Meta connection from contract_signed onward, but never at paid or cancelled', () => {
    expect(canBindMetaConnection('paid')).toBe(false);
    expect(canBindMetaConnection('contract_signed')).toBe(true);
    expect(canBindMetaConnection('active')).toBe(true);
    expect(canBindMetaConnection('cancelled')).toBe(false);
  });

  it('re-binds a Meta connection on a live subscription (token expiry reconnect)', () => {
    expect(canBindMetaConnection('active')).toBe(true);
    expect(canBindMetaConnection('paused')).toBe(true);
  });

  it('binds a virtual number only once WhatsApp is connected', () => {
    expect(canBindVirtualNumber('contract_signed')).toBe(false);
    expect(canBindVirtualNumber('meta_connected')).toBe(true);
    expect(canBindVirtualNumber('number_assigned')).toBe(true);
    // Re-binding on a live row is legal: numbers get flagged and replaced.
    expect(canBindVirtualNumber('active')).toBe(true);
    expect(canBindVirtualNumber('cancelled')).toBe(false);
  });

  it('binds a Google connection at any point except cancelled — the review half is independent', () => {
    expect(canBindGoogleConnection('paid')).toBe(true);
    expect(canBindGoogleConnection('active')).toBe(true);
    expect(canBindGoogleConnection('cancelled')).toBe(false);
  });

  it('accepts a greeting recording from meta_connected onward, and forever after', () => {
    expect(canRecordGreeting('contract_signed')).toBe(false);
    expect(canRecordGreeting('meta_connected')).toBe(true);
    expect(canRecordGreeting('active')).toBe(true);
    expect(canRecordGreeting('cancelled')).toBe(false);
  });

  it('treats an unknown status as un-bindable for the sequence-based gates', () => {
    expect(canBindVirtualNumber('nonsense')).toBe(false);
    expect(canRecordGreeting('nonsense')).toBe(false);
  });
});

describe('side exits', () => {
  it('pauses only a live subscription', () => {
    expect(canPause('active')).toBe(true);
    expect(canPause('forwarding_pending')).toBe(false);
    expect(canPause('paused')).toBe(false);
    expect(canPause('cancelled')).toBe(false);
  });

  it('resumes only a paused one', () => {
    expect(canResume('paused')).toBe(true);
    expect(canResume('active')).toBe(false);
    expect(canResume('cancelled')).toBe(false);
  });

  it('cancels from anywhere except an already-cancelled row', () => {
    for (const status of RECALL_STATUSES.filter((s) => s !== 'cancelled')) {
      expect(canCancel(status)).toBe(true);
    }
    expect(canCancel('cancelled')).toBe(false);
  });
});

describe('stuck detection', () => {
  const NOW = new Date('2026-09-10T12:00:00.000Z');
  function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  }

  it('has no threshold for the resting states', () => {
    expect(stuckThresholdDays('active')).toBeNull();
    expect(stuckThresholdDays('paused')).toBeNull();
    expect(stuckThresholdDays('cancelled')).toBeNull();
  });

  it('chases the client-blocked states hardest', () => {
    // forwarding_pending is THE failure mode of the product: he paid and
    // never dialled the codes.
    expect(stuckThresholdDays('forwarding_pending')).toBe(1);
    // Meta's own review queue gets more rope than the client does.
    expect(stuckThresholdDays('templates_approved')).toBe(4);
    expect(stuckThresholdDays('templates_approved')!).toBeGreaterThan(
      stuckThresholdDays('forwarding_pending')!,
    );
  });

  it('is not stuck before the threshold and is stuck at or after it', () => {
    expect(isStuck('forwarding_pending', daysAgo(0.5), NOW)).toBe(false);
    expect(isStuck('forwarding_pending', daysAgo(1), NOW)).toBe(true);
    expect(isStuck('forwarding_pending', daysAgo(9), NOW)).toBe(true);

    expect(isStuck('templates_approved', daysAgo(3), NOW)).toBe(false);
    expect(isStuck('templates_approved', daysAgo(4), NOW)).toBe(true);
  });

  it('never reports a resting state as stuck, however long it has sat there', () => {
    expect(isStuck('active', daysAgo(400), NOW)).toBe(false);
    expect(isStuck('paused', daysAgo(400), NOW)).toBe(false);
    expect(isStuck('cancelled', daysAgo(400), NOW)).toBe(false);
  });

  it('never reports an unknown status as stuck', () => {
    expect(isStuck('nonsense', daysAgo(400), NOW)).toBe(false);
  });
});
