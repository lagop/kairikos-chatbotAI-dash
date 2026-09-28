// =============================================================================
// Seguridad (22/09/2026) — dos cierres pequeños que fallaban en silencio:
//   • la IP de los límites de intentos salía de la primera entrada de
//     X-Forwarded-For, que escribe el propio cliente;
//   • el modo de pruebas del portal se activaba en producción solo porque
//     faltaban las variables de Supabase.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { isPortalDevMock } from '@/lib/portal-session';

describe('clientIpFromHeaders', () => {
  it('prefiere X-Real-Ip, que pone el proxy', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }))).toBe('203.0.113.7');
  });

  it('sin X-Real-Ip, la ÚLTIMA de X-Forwarded-For (la que añadió el proxy), no la primera', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.2.3.4, 10.9.9.9, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('sin cabeceras, "unknown"', () => {
    expect(clientIpFromHeaders(new Headers())).toBe('unknown');
  });
});

describe('isPortalDevMock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('en producción no se activa aunque falten las variables de Supabase', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    vi.stubEnv('ALLOW_PORTAL_DEV_MOCK', '');
    expect(isPortalDevMock()).toBe(false);
  });

  it('en producción solo si se pide explícitamente (lo hace CI)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('ALLOW_PORTAL_DEV_MOCK', '1');
    expect(isPortalDevMock()).toBe(true);
  });

  it('en desarrollo sigue como siempre', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(isPortalDevMock()).toBe(true);
  });
});
