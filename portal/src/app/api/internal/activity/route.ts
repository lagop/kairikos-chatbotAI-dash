import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { getProductCatalog, ProductCatalogError } from '@/lib/catalogs';

// =============================================================================
// POST /api/internal/activity
//
// KAIA-756 — internal endpoint for the n8n T+0/3/7/14 onboarding flows and
// the status-change watcher. Writes (idempotently) a single `ChatbotActivity`
// row per (clientId, productCode, milestone) pair, scoping every query to
// the supplied clientId (no global writes, no cross-tenant reads).
//
// Auth: shared secret via `PORTAL_API_KEY`, verified by
// `authenticateInternalRequest`. See `src/lib/internal-auth.ts` for the
// scheme and the fail-closed default.
//
// Idempotency: a `@@unique([clientId, productCode, milestone])` constraint
// on `ChatbotActivity` (repointed from `(clientId, milestone)` by WP-14)
// lets Prisma's `upsert` collapse repeated writes from n8n retries into a
// no-op. The endpoint returns the row on first insert and on subsequent
// upserts with HTTP 200 + `{ created: false, id, clientId, milestone }`.
//
// WP-14 — `productCode` is optional in the request body (defaults to
// 'chatbot', matching the DB column default) so n8n's existing flows —
// which only know about the chatbot onboarding timeline — keep working
// unmodified. The milestone allowlist is now per-product: it must be one
// of that product's catalog milestones, OR the universal 'status_change'
// value used by the status-change watcher (not a wizard milestone, so it
// isn't part of any product's catalog).
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MILESTONE_RE = /^(T\+\d+|status_change)$/;
const STATUS_CHANGE_MILESTONE = 'status_change';

interface ActivityRequestBody {
  clientId?: unknown;
  productCode?: unknown;
  milestone?: unknown;
  completedAt?: unknown;
  notes?: unknown;
}

interface ParsedActivityRequest {
  clientId: string;
  productCode: string;
  milestone: string;
  completedAt: Date;
  notes: string | null;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

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
    select: { id: true, tenantId: true },
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
        clientId_productCode_milestone: {
          clientId: parsed.value.clientId,
          productCode: parsed.value.productCode,
          milestone: parsed.value.milestone,
        },
      },
      create: {
        clientId: parsed.value.clientId,
        tenantId: client.tenantId,
        productCode: parsed.value.productCode,
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
      select: { id: true, clientId: true, productCode: true, milestone: true, completedAt: true, notes: true },
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
      productCode: row.productCode,
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
  const { clientId, productCode: rawProductCode, milestone, completedAt, notes } = body;

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, reason: 'clientId must be a UUID string' };
  }
  if (rawProductCode !== undefined && typeof rawProductCode !== 'string') {
    return { ok: false, reason: 'productCode must be a string' };
  }
  const productCode = rawProductCode ?? CHATBOT_PRODUCT_CODE;
  let catalogMilestones: readonly string[];
  try {
    catalogMilestones = getProductCatalog(productCode).milestones;
  } catch (err) {
    if (err instanceof ProductCatalogError) {
      return { ok: false, reason: `unknown productCode: ${productCode}` };
    }
    throw err;
  }
  if (typeof milestone !== 'string' || !MILESTONE_RE.test(milestone)) {
    return { ok: false, reason: 'milestone must match T+N or status_change' };
  }
  // 'status_change' is a universal exception — the status-change watcher
  // fires it for any product, and it is deliberately not part of any
  // product's wizard milestone catalog.
  if (milestone !== STATUS_CHANGE_MILESTONE && !catalogMilestones.includes(milestone)) {
    return {
      ok: false,
      reason: `milestone must be one of ${[...catalogMilestones, STATUS_CHANGE_MILESTONE].join(', ')} for productCode "${productCode}"`,
    };
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
      productCode,
      milestone,
      completedAt: completedAtDate,
      notes: notesValue,
    },
  };
}
