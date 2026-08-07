// KAIA-11932 — page-lambda env visibility debug route.
//
// Why this lives under /portal/debug-env (not /api/debug/...): Next.js
// App Router groups lambdas by route segment. The /portal/dashboard
// page lives in the /portal/* lambda; the /api/* routes live in a
// different lambda. Comparing env between those two lambdas does NOT
// tell us what /portal/dashboard sees — by placing this route under
// /portal/ it gets bundled into the same serverless function as the
// dashboard page, so its process.env should match exactly what the
// page sees at request time.
//
// Same shared-secret gate as the /api/debug/* routes.

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
    lambda: 'page-lambda (portal/debug-env)',
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
      'This route is bundled into the same /portal/* serverless function as /portal/dashboard. process.env seen here is what the page lambda sees.',
  });
}
