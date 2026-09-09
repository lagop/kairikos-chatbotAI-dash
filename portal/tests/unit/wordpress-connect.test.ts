// =============================================================================
// SEO con IA, Fase 5 — unit tests for lib/wordpress-connect.ts. Pure
// functions, no I/O: URL building for the WordPress "authorize
// application" screen, and parsing what it sends back.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildAuthorizeApplicationUrl,
  parseAuthorizeCallback,
  WORDPRESS_CONNECT_APP_ID,
  WORDPRESS_CONNECT_APP_NAME,
} from '@/lib/wordpress-connect';

describe('buildAuthorizeApplicationUrl', () => {
  it('builds a wp-admin/authorize-application.php URL carrying app_name, app_id, success_url and reject_url', () => {
    const url = buildAuthorizeApplicationUrl('https://negocio.example', {
      successUrl: 'https://portal.kairikos.com/api/portal/seo/wordpress/callback?state=abc',
      rejectUrl: 'https://portal.kairikos.com/portal/seo?wp_connect_error=wordpress_rejected',
    });
    expect(url).toBeTruthy();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe('https://negocio.example');
    expect(parsed.pathname).toBe('/wp-admin/authorize-application.php');
    expect(parsed.searchParams.get('app_name')).toBe(WORDPRESS_CONNECT_APP_NAME);
    expect(parsed.searchParams.get('app_id')).toBe(WORDPRESS_CONNECT_APP_ID);
    expect(parsed.searchParams.get('success_url')).toBe(
      'https://portal.kairikos.com/api/portal/seo/wordpress/callback?state=abc',
    );
    expect(parsed.searchParams.get('reject_url')).toBe(
      'https://portal.kairikos.com/portal/seo?wp_connect_error=wordpress_rejected',
    );
  });

  it('keeps app_id fixed across calls — a second authorization must update the same WordPress app, not create a new one', () => {
    const a = buildAuthorizeApplicationUrl('https://uno.example', { successUrl: 's', rejectUrl: 'r' });
    const b = buildAuthorizeApplicationUrl('https://dos.example', { successUrl: 's', rejectUrl: 'r' });
    const appIdOf = (u: string) => new URL(u).searchParams.get('app_id');
    expect(appIdOf(a as string)).toBe(appIdOf(b as string));
  });

  it('returns null for a siteUrl that is not a valid URL', () => {
    expect(buildAuthorizeApplicationUrl('not a url', { successUrl: 's', rejectUrl: 'r' })).toBeNull();
  });

  it('returns null for a non-http(s) protocol', () => {
    expect(buildAuthorizeApplicationUrl('ftp://negocio.example', { successUrl: 's', rejectUrl: 'r' })).toBeNull();
  });

  it('strips any existing path on siteUrl — the authorize screen always lives at the site root', () => {
    const url = buildAuthorizeApplicationUrl('https://negocio.example/blog/', { successUrl: 's', rejectUrl: 'r' });
    expect(new URL(url as string).pathname).toBe('/wp-admin/authorize-application.php');
  });
});

describe('parseAuthorizeCallback', () => {
  it('parses a complete successful callback', () => {
    const params = new URLSearchParams({
      site_url: 'https://negocio.example',
      user_login: 'admin',
      password: 'xxxx xxxx xxxx xxxx xxxx xxxx',
    });
    expect(parseAuthorizeCallback(params)).toEqual({
      ok: true,
      siteUrl: 'https://negocio.example',
      username: 'admin',
      password: 'xxxx xxxx xxxx xxxx xxxx xxxx',
    });
  });

  it('fails when any of the three params is missing', () => {
    expect(parseAuthorizeCallback(new URLSearchParams({ user_login: 'admin', password: 'x' }))).toEqual({
      ok: false,
      error: 'missing_params',
    });
    expect(parseAuthorizeCallback(new URLSearchParams({ site_url: 'https://x.example', password: 'x' }))).toEqual({
      ok: false,
      error: 'missing_params',
    });
    expect(parseAuthorizeCallback(new URLSearchParams({ site_url: 'https://x.example', user_login: 'admin' }))).toEqual({
      ok: false,
      error: 'missing_params',
    });
  });

  it('fails on an all-empty query string', () => {
    expect(parseAuthorizeCallback(new URLSearchParams())).toEqual({ ok: false, error: 'missing_params' });
  });

  it('trims surrounding whitespace', () => {
    const params = new URLSearchParams({ site_url: '  https://negocio.example  ', user_login: ' admin ', password: ' pw ' });
    const result = parseAuthorizeCallback(params);
    expect(result).toEqual({ ok: true, siteUrl: 'https://negocio.example', username: 'admin', password: 'pw' });
  });
});
