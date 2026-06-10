import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// POST /api/internal/lookup-client
//
// KAIA-756.1 — sibling internal endpoint consumed by the four n8n T+0/3/7/14
// flows. Resolves a `ChatbotClient.id` (the "clientId" used everywhere in
// the portal API) from a contact email captured on the Tally intake form.
//
// Auth: same shared secret (`PORTAL_API_KEY`) as /api/internal/activity.
// The check is delegated to the reusable wrapper in
// `src/lib/internal-auth.ts` so every /api/internal/* route fails closed
// in the same way.
//
// Response shape (success):
//   { clientId: <cuid>, companyName: <text|null>, contactEmail: <email> }
//
// Failure modes:
//   400 — body is not valid JSON, missing email, or email is not a string.
//   401 — `unauthorized` (bad / missing X-Kairikos-Internal-Key).
//   404 — `not_found` (no ChatbotClient row matches the email).
//   500 — `server_misconfigured` (PORTAL_API_KEY unset).
//   503 — `database_not_configured` (DATABASE_URL unset).
//
// Idempotency: this is a read-only route (no Prisma write), so retries are
// always safe. The lookup is keyed on the unique `ChatbotClient.email`
// column — at most one row can match.
// =============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface LookupRequestBody {
  email?: unknown;
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

  if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'email must be a valid email string' },
      { status: 400 },
    );
  }

  const normalized = body.email.trim().toLowerCase();

  const client = await prisma.chatbotClient.findUnique({
    where: { email: normalized },
    select: { id: true, companyName: true, email: true },
  });
  if (!client) {
    return NextResponse.json(
      { error: 'not_found', detail: 'no ChatbotClient matches the email' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    clientId: client.id,
    companyName: client.companyName ?? null,
    contactEmail: client.email,
  });
}

// 405 for other methods so callers get a clear error.
export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
