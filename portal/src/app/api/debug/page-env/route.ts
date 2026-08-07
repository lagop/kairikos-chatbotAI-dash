// KAIA-11932 — page-lambda env visibility debug route.
//
// Why this exists: the Backend Developer (run f4f2d6bc, comment f6534ac8)
// verified that the Vercel project env has NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY / DATABASE_URL / DIRECT_URL set on the
// production scope, but the /portal/dashboard page lambda still routes
// to mock_dev while /api/portal/me returns the real customer data. We
// need to see exactly what process.env looks like from inside the same
// lambda that serves the page.
//
// Contract: this route is intentionally read-only. It does NOT call
// resolveClientFromSession() (that would mutate behavior) and it does
// NOT require a session. It returns:
//   - the raw string values (with the secret part of the ANON key redacted)
//   - a boolean per var for "is set / is placeholder"
//   - isPortalDevMock() result (so we can match the page's branch logic)
//   - a few runtime markers so we can distinguish per-lambda state
//
// This route is gated by a header so it cannot be exercised from the
// public internet. The CEO will pass the header value in the smoke
// command. After we identify the missing/inlined env var, this route
// must be removed or feature-flagged off (the issue instructions are
// explicit on that).

import { NextResponse, type NextRequest } from 'next/server';
import { isPortalDevMock } from '@/lib/portal-session';
import { isDatabaseConfigured } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEBUG_HEADER = 'x-kairikos-debug-key';
const EXPECTED_DEBUG_KEY = process.env.KAIRIKOS_DEBUG_KEY ?? '';

function redactKey(value: string | undefined): string {
  if (!value) return '';
  if (value === 'placeholder' || value === 'placeholder-key' || value.length < 8) return value;
  const prefix = value.slice(0, 12);
  const suffix = value.slice(-6);
  return `${prefix}…${suffix} (len=${value.length})`;
}

function safeBool(value: string | undefined, placeholders: string[]): string {
  if (!value) return 'missing';
  if (placeholders.some((p) => value.includes(p))) return 'placeholder';
  return 'set';
}

export async function GET(req: NextRequest) {
  // Minimal shared-secret gate. If KAIRIKOS_DEBUG_KEY is unset the route
  // refuses outright (no accidental debug exposure in environments where
  // the env var isn't configured). When it is set, the request must
  // present the same value in the X-Kairikos-Debug-Key header.
  if (!EXPECTED_DEBUG_KEY) {
    return NextResponse.json(
      { error: 'debug_disabled', detail: 'KAIRIKOS_DEBUG_KEY is not set on this lambda.' },
      { status: 404 },
    );
  }
  const presented = req.headers.get(DEBUG_HEADER) ?? '';
  if (presented !== EXPECTED_DEBUG_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  const vercelEnv = process.env.VERCEL_ENV ?? '';
  const nodeEnv = process.env.NODE_ENV ?? '';
  const region = process.env.VERCEL_REGION ?? '';

  const placeholders = ['YOUR-PROJECT', 'invalid.supabase.co', 'placeholder.supabase.co'];

  return NextResponse.json({
    lambda: 'page-env',
    runtime: {
      nodeEnv,
      vercelEnv,
      region,
      timestamp: new Date().toISOString(),
    },
    env: {
      NEXT_PUBLIC_SUPABASE_URL: {
        state: safeBool(supabaseUrl, placeholders),
        // Use prefix/suffix so we don't leak the full URL publicly.
        preview: supabaseUrl ? `${supabaseUrl.slice(0, 12)}…${supabaseUrl.slice(-8)}` : '',
      },
      NEXT_PUBLIC_SUPABASE_ANON_KEY: {
        state: safeBool(supabaseKey, [...placeholders, 'placeholder-key']),
        preview: redactKey(supabaseKey),
      },
      DATABASE_URL: {
        state: databaseUrl ? 'set' : 'missing',
        preview: databaseUrl ? redactKey(databaseUrl) : '',
      },
      DIRECT_URL: {
        state: directUrl ? 'set' : 'missing',
        preview: directUrl ? redactKey(directUrl) : '',
      },
    },
    derived: {
      isPortalDevMock: isPortalDevMock(),
      isDatabaseConfigured,
    },
    note:
      'Compare this with the /api/portal/me route response. If NEXT_PUBLIC_SUPABASE_URL is missing or placeholder here but set on /api/portal/me, the page lambda is reading from a different runtime env than the API route.',
  });
}
