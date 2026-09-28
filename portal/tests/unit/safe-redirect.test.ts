// Revisión de seguridad del 22/09/2026 — redirección abierta en el cierre
// de sesión. Ver src/lib/safe-redirect.ts.

import { describe, it, expect } from 'vitest';
import { safeInternalPath } from '@/lib/safe-redirect';

const FALLBACK = '/portal/login';

describe('safeInternalPath', () => {
  it.each([
    ['/portal', '/portal'],
    ['/portal/seo?connected=1', '/portal/seo?connected=1'],
    ['/admin/portal/clients#top', '/admin/portal/clients#top'],
  ])('keeps an internal path: %s', (input, expected) => {
    expect(safeInternalPath(input, FALLBACK)).toBe(expected);
  });

  it.each([
    '//evil.example',
    '//evil.example/portal/login',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'portal',
    '',
    `/${'a'.repeat(3000)}`,
  ])('falls back for %j', (input) => {
    expect(safeInternalPath(input, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for non-strings (a missing form field is null)', () => {
    expect(safeInternalPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
