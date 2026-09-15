// =============================================================================
// Cuándo caduca de verdad un token de Meta — ver src/lib/meta-token-expiry.ts
// y el incidente de producción del 2026-09-15 que lo motivó.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseDebugTokenResponse,
  resolveTokenExpiry,
  isUnusableToken,
  MIN_TOKEN_LIFETIME_DAYS,
} from '@/lib/meta-token-expiry';

const NOW = new Date('2026-09-14T16:57:09Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('parseDebugTokenResponse', () => {
  it('lee is_valid, expires_at (segundos) y type', () => {
    const expiresAt = Math.floor(new Date('2026-11-13T00:00:00Z').getTime() / 1000);
    expect(parseDebugTokenResponse({ data: { is_valid: true, expires_at: expiresAt, type: 'USER' } })).toEqual({
      isValid: true,
      expiresAt: new Date('2026-11-13T00:00:00Z'),
      type: 'USER',
    });
  });

  it('expires_at 0 es "no caduca", dicho explícitamente por Meta', () => {
    expect(parseDebugTokenResponse({ data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER' } })?.expiresAt).toBeNull();
  });

  it('una respuesta sin expires_at numérico no se interpreta — el llamante cae a expires_in', () => {
    expect(parseDebugTokenResponse({ data: { is_valid: true } })).toBeNull();
    expect(parseDebugTokenResponse({ error: { message: 'bad app token' } })).toBeNull();
    expect(parseDebugTokenResponse(null)).toBeNull();
  });
});

describe('resolveTokenExpiry', () => {
  it('debug_token manda sobre expires_in', () => {
    const real = new Date(NOW.getTime() + HOUR);
    expect(resolveTokenExpiry({ inspected: { isValid: true, expiresAt: real, type: 'USER' }, expiresIn: 5_184_000, now: NOW })).toEqual(real);
  });

  it('sin debug_token, usa expires_in como antes', () => {
    expect(resolveTokenExpiry({ inspected: null, expiresIn: 3600, now: NOW })).toEqual(new Date(NOW.getTime() + HOUR));
  });

  it('sin ninguna de las dos, desconocida — nunca se inventa una fecha', () => {
    expect(resolveTokenExpiry({ inspected: null, expiresIn: null, now: NOW })).toBeNull();
  });
});

describe('isUnusableToken', () => {
  it('el caso de producción: un token que caduca en una hora se rechaza', () => {
    const inspected = { isValid: true, expiresAt: new Date('2026-09-14T18:00:00Z'), type: 'USER' };
    expect(isUnusableToken({ inspected, expiresAt: inspected.expiresAt, now: NOW })).toBe(true);
  });

  it(`por debajo de ${MIN_TOKEN_LIFETIME_DAYS} días se rechaza; por encima, no`, () => {
    const justUnder = new Date(NOW.getTime() + MIN_TOKEN_LIFETIME_DAYS * DAY - HOUR);
    const longLived = new Date(NOW.getTime() + 60 * DAY);
    expect(isUnusableToken({ inspected: null, expiresAt: justUnder, now: NOW })).toBe(true);
    expect(isUnusableToken({ inspected: null, expiresAt: longLived, now: NOW })).toBe(false);
  });

  it('un token que Meta da por inválido se rechaza aunque no caduque', () => {
    expect(isUnusableToken({ inspected: { isValid: false, expiresAt: null, type: 'USER' }, expiresAt: null, now: NOW })).toBe(true);
  });

  it('"no caduca" explícito se acepta', () => {
    expect(isUnusableToken({ inspected: { isValid: true, expiresAt: null, type: 'SYSTEM_USER' }, expiresAt: null, now: NOW })).toBe(false);
  });
});
