// =============================================================================
// WP-XX — Leads Fase 2: status-transition predicates in src/lib/leads.ts.
// Boundary coverage for each canX(status) function — mirrors how
// web-quotes.ts's equivalent predicates would be tested if a test file
// existed for them (none does today; this is the first of its kind).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { canDiscard, canMarkContacted, canMarkConverted } from '@/lib/leads';

describe('canMarkContacted (nuevo -> contactado)', () => {
  it('allows from nuevo', () => {
    expect(canMarkContacted('nuevo')).toBe(true);
  });

  it('denies from every other status', () => {
    expect(canMarkContacted('contactado')).toBe(false);
    expect(canMarkContacted('convertido')).toBe(false);
    expect(canMarkContacted('descartado')).toBe(false);
    expect(canMarkContacted('')).toBe(false);
    expect(canMarkContacted('unknown')).toBe(false);
  });
});

describe('canMarkConverted (contactado -> convertido)', () => {
  it('allows from contactado', () => {
    expect(canMarkConverted('contactado')).toBe(true);
  });

  it('denies from every other status, including nuevo (cannot skip contactado)', () => {
    expect(canMarkConverted('nuevo')).toBe(false);
    expect(canMarkConverted('convertido')).toBe(false);
    expect(canMarkConverted('descartado')).toBe(false);
    expect(canMarkConverted('')).toBe(false);
    expect(canMarkConverted('unknown')).toBe(false);
  });
});

describe('canDiscard (side-exit: nuevo|contactado -> descartado)', () => {
  it('allows from nuevo', () => {
    expect(canDiscard('nuevo')).toBe(true);
  });

  it('allows from contactado', () => {
    expect(canDiscard('contactado')).toBe(true);
  });

  it('denies from terminal statuses (convertido, descartado) and unknown values', () => {
    expect(canDiscard('convertido')).toBe(false);
    expect(canDiscard('descartado')).toBe(false);
    expect(canDiscard('')).toBe(false);
    expect(canDiscard('unknown')).toBe(false);
  });
});
