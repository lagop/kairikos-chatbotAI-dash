// KAIA-11932 — API-lambda env comparison debug route.
//
// Same shape as /api/debug/page-env, but placed under /api/debug/api-env
// so the bucketed/route classifier on the build output (which groups
// every /api/* route into one serverless function) puts it on the same
// serverless bundle as /api/portal/me. Comparing the two outputs tells
// us whether the page lambda's process.env genuinely differs from the
// API lambda's process.env, or whether the page is reading an inlined
// build-time value somewhere despite the env being set at runtime.
//
// Same shared-secret gate as /api/debug/page-env.

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
    lambda: 'api-env',
    runtime: {
      nodeEnv,
      vercelEnv,
      region,
      timestamp: new Date().toISOString(),
    },
    env: {
      NEXT_PUBLIC_SUPABASE_URL: {
        state: safeBool(supabaseUrl, placeholders),
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
      'API-route lambda. Diff against /api/debug/page-env to see whether the page lambda sees a different env than the API route lambda.',
  });
}
