// =============================================================================
// KAIA-2872 — unit tests for `ensurePgBouncerFlags`.
//
// The helper appends `pgbouncer=true` and `connection_limit=1` to a Postgres
// URL when those flags are missing. This is the canonical Prisma
// workaround for the 42P05 "prepared statement already exists" error that
// occurs when Prisma's prepared-statement cache collides with PgBouncer's
// transaction-mode recycling.
//
// Run with: `npm run test:unit -- prisma-pg-flags`.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { ensurePgBouncerFlags } from '@/lib/prisma-pg-flags';

const POOLED = 'postgresql://postgres.ikexqreuvoqwvwopftkt:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres';
const POOLED_FIXED =
  'postgresql://postgres.ikexqreuvoqwvwopftkt:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
const DIRECT = 'postgresql://postgres.ikexqreuvoqwvwopftkt:secret@aws-0-eu-west-3.pooler.supabase.com:5432/postgres';

describe('ensurePgBouncerFlags (KAIA-2872)', () => {
  it('returns undefined when the input is undefined', () => {
    expect(ensurePgBouncerFlags(undefined)).toBeUndefined();
  });

  it('returns undefined when the input is null', () => {
    expect(ensurePgBouncerFlags(null)).toBeUndefined();
  });

  it('returns the empty string unchanged when the input is empty', () => {
    expect(ensurePgBouncerFlags('')).toBe('');
  });

  it('returns a non-postgres URL unchanged (sqlite)', () => {
    expect(ensurePgBouncerFlags('file:./dev.db')).toBe('file:./dev.db');
  });

  it('appends pgbouncer=true and connection_limit=1 to a pooled URL with no flags', () => {
    expect(ensurePgBouncerFlags(POOLED)).toBe(POOLED_FIXED);
  });

  it('is a no-op on a pooled URL that already has both flags', () => {
    expect(ensurePgBouncerFlags(POOLED_FIXED)).toBe(POOLED_FIXED);
  });

  it('appends only connection_limit when pgbouncer is already set', () => {
    const input =
      'postgresql://u:p@h:6543/db?pgbouncer=true';
    const expected =
      'postgresql://u:p@h:6543/db?pgbouncer=true&connection_limit=1';
    expect(ensurePgBouncerFlags(input)).toBe(expected);
  });

  it('appends only pgbouncer when connection_limit is already set', () => {
    const input =
      'postgresql://u:p@h:6543/db?connection_limit=2';
    const expected =
      'postgresql://u:p@h:6543/db?connection_limit=2&pgbouncer=true';
    expect(ensurePgBouncerFlags(input)).toBe(expected);
  });

  it('preserves an existing fragment', () => {
    const input = `${POOLED}#section-1`;
    const expected = `${POOLED_FIXED}#section-1`;
    expect(ensurePgBouncerFlags(input)).toBe(expected);
  });

  it('preserves an existing query string and adds the missing flags', () => {
    const input =
      'postgresql://u:p@h:6543/db?schema=public&application_name=portal';
    const expected =
      'postgresql://u:p@h:6543/db?schema=public&application_name=portal&pgbouncer=true&connection_limit=1';
    expect(ensurePgBouncerFlags(input)).toBe(expected);
  });

  it('preserves the direct (port 5432) URL but still adds the flags as a no-op safety net', () => {
    // On a direct connection the flags are harmless (Prisma ignores
    // pgbouncer=true when it sees the backend is the real Postgres). We
    // still append them so a code-only deployment cannot regress.
    const expected =
      'postgresql://postgres.ikexqreuvoqwvwopftkt:secret@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?pgbouncer=true&connection_limit=1';
    expect(ensurePgBouncerFlags(DIRECT)).toBe(expected);
  });

  it('does not double-set pgbouncer if it is already in the URL twice (defensive)', () => {
    const input =
      'postgresql://u:p@h:6543/db?pgbouncer=true&pgbouncer=true&connection_limit=4';
    // URLSearchParams dedupes by key, so the result will have the
    // first-seen value for `pgbouncer` and a single `connection_limit`.
    const result = ensurePgBouncerFlags(input);
    expect(result).toContain('pgbouncer=true');
    expect(result).toContain('connection_limit=4');
  });
});
