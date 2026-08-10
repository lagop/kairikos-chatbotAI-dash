// =============================================================================
// KAIA-13797 — `/api/qa-probe`
//
// Server-side SSR probe used by the QA harness to verify that operator-only
// `/admin/portal/**` pages render without `MOCK_*` fallback literals on the
// staging deploy (`https://project-fxidg.vercel.app`).
//
// Contract (kept in sync with KAIA-13778 acceptance criteria):
//   GET /api/qa-probe?path=/admin/portal/<clientId>[&tab=flow]
//   Header: X-QA-Probe-Token: <QA_PROBE_TOKEN>
//
// Behaviour:
//   404  — `QA_PROBE_TOKEN` is unset or empty (probe disabled; prod-safe).
//   401  — `X-QA-Probe-Token` missing or does not match.
//   400  — `path` missing, not a string, or outside the `/admin/portal/`
//          allowlist.
//   200  — Returns the raw SSR HTML body of the requested path with
//          `Content-Type: text/html; charset=utf-8`. The subrequest uses the
//          existing `KAIA_OPERATOR_API_KEY` (`x-kaia-operator-key`) as the
//          operator session bridge — the page loader already honours that
//          header so this route does not need to duplicate auth.
//
// Neither `QA_PROBE_TOKEN` nor `KAIA_OPERATOR_API_KEY` is echoed in the
// response body or in any log line.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_PATH_PREFIX = '/admin/portal/';
const TAB_WHITELIST = new Set(['overview', 'flow']);
// Hard cap on the rendered HTML the route will hand back. Vercel route
// handlers stream the body; this keeps a malicious caller from asking us
// to materialise an arbitrarily large response.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildSelfUrl(req: NextRequest, pathname: string, tab: string | null): string {
  // Prefer VERCEL_URL (always set on Vercel) and fall back to the incoming
  // request URL so the route is also exercisable on `next dev` (where
  // VERCEL_URL is undefined). The protocol defaults to https because the
  // header value is host-only.
  const host =
    process.env.VERCEL_URL ||
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    `localhost:${process.env.PORT ?? '3001'}`;
  const protocol =
    process.env.VERCEL_ENV === 'production' || host.startsWith('localhost')
      ? host.startsWith('localhost')
        ? 'http'
        : 'https'
      : 'https';
  const search = tab ? `?tab=${encodeURIComponent(tab)}` : '';
  return `${protocol}://${host}${pathname}${search}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const envToken = process.env.QA_PROBE_TOKEN;
  if (!envToken || envToken.length < 32) {
    // Probe is intentionally silent in prod — same shape as a 404 the
    // Next.js router would emit for an unknown route, so a misconfigured
    // prod deploy cannot accidentally expose the surface.
    return new NextResponse('Not Found', { status: 404 });
  }

  const provided = req.headers.get('x-qa-probe-token');
  if (!provided || !timingSafeEqualStrings(provided, envToken)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const url = new URL(req.url);
  const pathParam = url.searchParams.get('path');
  if (!pathParam || !pathParam.startsWith(ALLOWED_PATH_PREFIX)) {
    return NextResponse.json(
      { error: 'invalid_path', message: 'path must start with /admin/portal/' },
      { status: 400 },
    );
  }
  // Reject query string / fragment sneaking in via the `path` param —
  // we only allow `tab=flow` style overrides built by the handler.
  if (pathParam.includes('?') || pathParam.includes('#')) {
    return NextResponse.json(
      { error: 'invalid_path', message: 'path must not include query or fragment' },
      { status: 400 },
    );
  }

  const rawTab = url.searchParams.get('tab');
  const tab = rawTab && TAB_WHITELIST.has(rawTab.toLowerCase()) ? rawTab.toLowerCase() : null;

  // Reuse the operator-key bypass to render the page server-side. The
  // page loader honours `x-kaia-operator-key` so the subrequest never
  // hits the `/portal/login` redirect path. We do NOT echo either env
  // value anywhere — only the rendered HTML body is returned.
  const operatorKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!operatorKey) {
    return NextResponse.json(
      {
        error: 'operator_key_missing',
        message: 'KAIA_OPERATOR_API_KEY must be set on staging for /api/qa-probe',
      },
      { status: 500 },
    );
  }

  const target = buildSelfUrl(req, pathParam, tab);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers: {
        'x-kaia-operator-key': operatorKey,
        // Bypass any client-side cache the Vercel CDN might serve, so QA
        // assertions see the freshest render.
        'cache-control': 'no-cache',
        accept: 'text/html',
      },
      redirect: 'manual',
    });
  } catch (err) {
    console.error('[qa-probe] self-fetch failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'upstream_failed', message: 'failed to fetch SSR HTML' },
      { status: 502 },
    );
  }

  // The operator key bypass should yield a 200 (or a 304 cache hit). Any
  // other status means the page redirected to /portal/login (auth broken)
  // or crashed. Surface that loudly so QA can diagnose instead of silently
  // returning the redirect target's HTML.
  if (upstream.status !== 200 && upstream.status !== 304) {
    return NextResponse.json(
      {
        error: 'upstream_status',
        status: upstream.status,
        location: upstream.headers.get('location') ?? null,
      },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  const trimmed = body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;

  return new NextResponse(trimmed, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-qa-probe-status': String(upstream.status),
    },
  });
}