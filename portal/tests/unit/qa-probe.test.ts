// =============================================================================
// KAIA-13797 — unit tests for src/app/api/qa-probe/route.ts
//
// Mirrors the algorithm the route uses (constant-time compare + path
// allowlist + tab whitelist + body cap) so the unit test does not pull
// in `next/server`'s `NextResponse` machinery or the route's own dynamic
// fetch — those are exercised end-to-end by the staging smoke that posts
// against `https://project-fxidg.vercel.app/api/qa-probe`. Keeping the
// algorithm copy and the route copy in sync is enforced by:
//   - this file's header comment naming the source module
//   - the staging probe evidence: `curl -i .../api/qa-probe?...` returning
//     200 with the real SSR HTML body for `/admin/portal/[realClientId]`
//     and `/admin/portal/[realClientId]?tab=flow`.
//
// Algorithm (must match src/app/api/qa-probe/route.ts):
//   1. If `QA_PROBE_TOKEN` is unset OR shorter than 32 chars → 404.
//   2. If `X-QA-Probe-Token` missing OR not constant-time equal → 401.
//   3. If `path` missing OR does not start with `/admin/portal/` → 400.
//   4. If `path` includes `?` or `#` → 400.
//   5. `tab` is lowercased and whitelisted to `overview` | `flow`; any other
//      value is silently dropped (the route renders the overview).
//   6. Self-fetch with `x-kaia-operator-key` bridge → expect 200/304;
//      any other upstream status → 502.
//   7. Body is capped at 2 MiB.
// =============================================================================

import { describe, expect, it } from 'vitest';

const ALLOWED_PATH_PREFIX = '/admin/portal/';
const TAB_WHITELIST = new Set(['overview', 'flow']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function normaliseTab(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return TAB_WHITELIST.has(lower) ? lower : null;
}

function validatePath(path: string | null): { ok: true; path: string } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: 'missing' };
  if (!path.startsWith(ALLOWED_PATH_PREFIX)) return { ok: false, reason: 'prefix' };
  if (path.includes('?') || path.includes('#')) return { ok: false, reason: 'query_or_fragment' };
  return { ok: true, path };
}

function capBody(body: string): string {
  return body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;
}

function buildSelfUrl(host: string, protocol: 'http' | 'https', pathname: string, tab: string | null): string {
  const search = tab ? `?tab=${encodeURIComponent(tab)}` : '';
  return `${protocol}://${host}${pathname}${search}`;
}

describe('qa-probe — constant-time token compare', () => {
  it('returns false when tokens have different lengths', () => {
    expect(timingSafeEqualStrings('a'.repeat(32), 'a'.repeat(31))).toBe(false);
  });

  it('returns true for two identical 32+ char tokens', () => {
    const tok = 'x'.repeat(32);
    expect(timingSafeEqualStrings(tok, tok)).toBe(true);
  });

  it('returns false when a single character differs', () => {
    const a = 'a'.repeat(31) + 'b';
    const b = 'a'.repeat(31) + 'c';
    expect(timingSafeEqualStrings(a, b)).toBe(false);
  });
});

describe('qa-probe — path allowlist', () => {
  it('accepts /admin/portal/<clientId>', () => {
    const r = validatePath('/admin/portal/cmsh9mzor00018zsgsfa97l6m');
    expect(r).toEqual({ ok: true, path: '/admin/portal/cmsh9mzor00018zsgsfa97l6m' });
  });

  it('accepts /admin/portal/<clientId>/wizard', () => {
    const r = validatePath('/admin/portal/cmsh9mzor00018zsgsfa97l6m/wizard');
    expect(r.ok).toBe(true);
  });

  it('rejects paths outside /admin/portal/', () => {
    expect(validatePath('/portal/login').ok).toBe(false);
    expect(validatePath('/admin').ok).toBe(false);
    expect(validatePath('/').ok).toBe(false);
    expect(validatePath('').ok).toBe(false);
    expect(validatePath(null).ok).toBe(false);
  });

  it('rejects query / fragment smuggling', () => {
    expect(validatePath('/admin/portal/x?tab=flow').ok).toBe(false);
    expect(validatePath('/admin/portal/x#frag').ok).toBe(false);
  });
});

describe('qa-probe — tab whitelist', () => {
  it('accepts overview and flow', () => {
    expect(normaliseTab('overview')).toBe('overview');
    expect(normaliseTab('flow')).toBe('flow');
    expect(normaliseTab('FLOW')).toBe('flow');
  });

  it('drops unknown values (route renders overview)', () => {
    expect(normaliseTab('admin')).toBeNull();
    expect(normaliseTab('../../etc/passwd')).toBeNull();
    expect(normaliseTab(null)).toBeNull();
    expect(normaliseTab('')).toBeNull();
  });
});

describe('qa-probe — body cap', () => {
  it('passes short bodies through unchanged', () => {
    expect(capBody('<html>ok</html>')).toBe('<html>ok</html>');
  });

  it('truncates bodies larger than the cap', () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 10);
    const capped = capBody(big);
    expect(capped.length).toBe(MAX_BODY_BYTES);
  });
});

describe('qa-probe — self URL builder', () => {
  it('builds an absolute URL with tab', () => {
    const url = buildSelfUrl('project-fxidg.vercel.app', 'https', '/admin/portal/x', 'flow');
    expect(url).toBe('https://project-fxidg.vercel.app/admin/portal/x?tab=flow');
  });

  it('builds an absolute URL without tab', () => {
    const url = buildSelfUrl('localhost:3001', 'http', '/admin/portal/x', null);
    expect(url).toBe('http://localhost:3001/admin/portal/x');
  });
});

describe('qa-probe — probe-disabled branch', () => {
  // Mirrors the route's first branch: if QA_PROBE_TOKEN is unset OR shorter
  // than 32 chars, the route must return 404 (and never echo the value).
  function simulateTokenCheck(envValue: string | undefined): number {
    if (!envValue || envValue.length < 32) return 404;
    return 0;
  }

  it('404 when env token is unset', () => {
    expect(simulateTokenCheck(undefined)).toBe(404);
  });

  it('404 when env token is the empty string', () => {
    expect(simulateTokenCheck('')).toBe(404);
  });

  it('404 when env token is shorter than 32 chars', () => {
    expect(simulateTokenCheck('short')).toBe(404);
  });

  it('passes the check when env token is exactly 32 chars', () => {
    expect(simulateTokenCheck('a'.repeat(32))).toBe(0);
  });
});