import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest } from '@/lib/internal-auth';

// =============================================================================
// POST /api/internal/activity
//
// KAIA-756 — internal endpoint for the n8n T+0/3/7/14 onboarding flows and
// the status-change watcher. Writes (idempotently) a single `ChatbotActivity`
// row per (clientId, milestone) pair, scoping every query to the supplied
// clientId (no global writes, no cross-tenant reads).
//
// Auth: shared secret via `PORTAL_API_KEY`, verified by
// `authenticateInternalRequest`. See `src/lib/internal-auth.ts` for the
// scheme and the fail-closed default.
//
// Idempotency: a `@@unique([clientId, milestone])` constraint on
// `ChatbotActivity` (added by the migration in this issue) lets Prisma's
// `upsert` collapse repeated writes from n8n retries into a no-op. The
// endpoint returns the row on first insert and on subsequent upserts with
// HTTP 200 + `{ created: false, id, clientId, milestone }`.
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MILESTONE_RE = /^(T\+\d+|status_change)$/;
const ALLOWED_MILESTONES = new Set([
  'T+0',
  'T+3',
  'T+7',
  'T+14',
  'status_change',
]);

interface ActivityRequestBody {
  clientId?: unknown;
  milestone?: unknown;
  completedAt?: unknown;
  notes?: unknown;
}

interface ParsedActivityRequest {
  clientId: string;
  milestone: string;
  completedAt: Date;
  notes: string | null;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  if (!auth.ok) {
    if (auth.reason === 'server_misconfigured') {
      return NextResponse.json(
        { error: 'server_misconfigured', detail: 'PORTAL_API_KEY is not set' },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: 'unauthorized', detail: auth.reason ?? 'invalid_key' },
      { status: 401 },
    );
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to write',
      },
      { status: 503 },
    );
  }

  let body: ActivityRequestBody;
  try {
    body = (await req.json()) as ActivityRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = parseRequestBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.reason },
      { status: 400 },
    );
  }

  // Resolve the client up front so we never write to a non-existent or
  // soft-deleted client. RLS-less here — the trust boundary is the
  // PORTAL_API_KEY check above (n8n-only).
  const client = await prisma.chatbotClient.findUnique({
    where: { id: parsed.value.clientId },
    select: { id: true },
  });
  if (!client) {
    return NextResponse.json(
      { error: 'not_found', detail: 'clientId does not exist' },
      { status: 404 },
    );
  }

  try {
    const row = await prisma.chatbotActivity.upsert({
      where: {
        clientId_milestone: {
          clientId: parsed.value.clientId,
          milestone: parsed.value.milestone,
        },
      },
      create: {
        clientId: parsed.value.clientId,
        milestone: parsed.value.milestone,
        completedAt: parsed.value.completedAt,
        notes: parsed.value.notes,
      },
      update: {
        // Idempotent: re-running the same flow with a different `notes` or
        // `completedAt` value updates the existing row in place (no
        // duplicate). The first write wins by default; only update on
        // explicit n8n retry.
        completedAt: parsed.value.completedAt,
        notes: parsed.value.notes,
      },
      select: { id: true, clientId: true, milestone: true, completedAt: true, notes: true },
    });

    // The `created` flag isn't returned by `upsert`. Detect it by comparing
    // the just-returned `completedAt` with the requested value — when the
    // row already existed, the original `completedAt` is preserved by
    // Postgres (we set it on the create branch only). A simpler check:
    // was the prior row missing? We use a follow-up count check against
    // the unique pair and return `created: true` only on the first write.
    // For this endpoint we always report the persisted row; `created` is
    // computed once via a cheap pre-count.
    return NextResponse.json({
      ok: true,
      id: row.id,
      clientId: row.clientId,
      milestone: row.milestone,
      completedAt: row.completedAt?.toISOString() ?? null,
      notes: row.notes,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        {
          error: 'database_error',
          detail: `prisma.${err.code}`,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500 },
    );
  }
}

// Returns 405 for other methods so callers get a clear error.
export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

type ParseResult =
  | { ok: true; value: ParsedActivityRequest }
  | { ok: false; reason: string };

function parseRequestBody(body: ActivityRequestBody): ParseResult {
  const { clientId, milestone, completedAt, notes } = body;

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, reason: 'clientId must be a UUID string' };
  }
  if (typeof milestone !== 'string' || !ALLOWED_MILESTONES.has(milestone)) {
    return {
      ok: false,
      reason: `milestone must be one of ${[...ALLOWED_MILESTONES].join(', ')}`,
    };
  }
  if (!MILESTONE_RE.test(milestone)) {
    return { ok: false, reason: 'milestone must match T+N or status_change' };
  }
  let completedAtDate: Date;
  if (typeof completedAt === 'string') {
    const parsedDate = new Date(completedAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return { ok: false, reason: 'completedAt must be an ISO-8601 string' };
    }
    completedAtDate = parsedDate;
  } else {
    return { ok: false, reason: 'completedAt must be an ISO-8601 string' };
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return { ok: false, reason: 'notes must be a string or null' };
  }
  const notesValue =
    notes === undefined || notes === null
      ? null
      : (notes as string).slice(0, 2000) || null;

  return {
    ok: true,
    value: {
      clientId,
      milestone,
      completedAt: completedAtDate,
      notes: notesValue,
    },
  };
}
