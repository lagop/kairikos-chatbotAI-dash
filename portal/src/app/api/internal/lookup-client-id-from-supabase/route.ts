import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// POST /api/internal/lookup-client-id-from-supabase
//
// KAIA-762 — resolves a Supabase chatbot_clients.id (UUID) to the portal's
// ChatbotClient.id (cuid) using the supabaseClientId column added by the
// migration in this issue. Called by the status-change-watcher n8n flow
// before writing a ChatbotActivity row.
//
// Auth: same shared secret (PORTAL_API_KEY) as /api/internal/activity and
// /api/internal/lookup-client. The check is delegated to the reusable
// wrapper in src/lib/internal-auth.ts.
//
// Response shape (success):
//   { clientId: <cuid> }
//
// Failure modes:
//   400 — body is not valid JSON, missing supabaseClientId, or not a UUID.
//   401 — unauthorized (bad / missing X-Kairikos-Internal-Key).
//   404 — not_found (no ChatbotClient row matches the Supabase UUID).
//   500 — server_misconfigured (PORTAL_API_KEY unset).
//   503 — database_not_configured (DATABASE_URL unset).
//
// Idempotency: read-only route (no Prisma write), so retries are always safe.
// The lookup is keyed on the unique supabaseClientId column — at most one
// row can match.
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LookupRequestBody {
  supabaseClientId?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to read',
      },
      { status: 503 },
    );
  }

  let body: LookupRequestBody;
  try {
    body = (await req.json()) as LookupRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  if (
    typeof body.supabaseClientId !== 'string' ||
    !UUID_RE.test(body.supabaseClientId)
  ) {
    return NextResponse.json(
      {
        error: 'bad_request',
        detail: 'supabaseClientId must be a UUID string',
      },
      { status: 400 },
    );
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { supabaseClientId: body.supabaseClientId },
    select: { id: true },
  });
  if (!client) {
    return NextResponse.json(
      { error: 'not_found', detail: 'no ChatbotClient matches the Supabase UUID' },
      { status: 404 },
    );
  }

  return NextResponse.json({ clientId: client.id });
}

// 405 for other methods so callers get a clear error.
export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';