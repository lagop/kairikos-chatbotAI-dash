// Revisión de seguridad del 22/09/2026 — las quince rutas de /api/cron/*
// comparaban el Bearer con `===`. Ver src/lib/cron-auth.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

function req(authorization?: string) {
  return { headers: new Headers(authorization ? { authorization } : {}) };
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('isAuthorizedCronRequest', () => {
  it('accepts exactly `Bearer <CRON_SECRET>`', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(isAuthorizedCronRequest(req('Bearer s3cret'))).toBe(true);
  });

  it.each([undefined, '', 'Bearer', 'Bearer s3cre', 'Bearer s3cretX', 'bearer s3cret', 's3cret'])(
    'rejects %j',
    (header) => {
      process.env.CRON_SECRET = 's3cret';
      expect(isAuthorizedCronRequest(req(header))).toBe(false);
    },
  );

  it('fails closed when CRON_SECRET is unset — even for "Bearer " with nothing after', () => {
    expect(isAuthorizedCronRequest(req('Bearer '))).toBe(false);
    expect(isAuthorizedCronRequest(req('Bearer undefined'))).toBe(false);
  });
});
