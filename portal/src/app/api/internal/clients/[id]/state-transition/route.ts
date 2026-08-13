import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateActivityKeyRequest,
  activityKeyAuthFailureResponse,
} from '@/lib/activity-key-auth';
import { logError } from '@/lib/observability';
import { mirrorChatbotStateToClientProduct } from '@/lib/client-product-lifecycle';

// =============================================================================
// POST /api/internal/clients/[id]/state-transition
//
// KAIA-3127 — internal endpoint the operator child issue [KAIA-3125.B](/KAI/issues/KAIA-3125.B)
// calls to flip `ChatbotClient.state`. The CEO direction at
// [KAIA-3125 comment 7a2f7f41](/KAI/issues/KAIA-3125#comment-7a2f7f41-0583-46eb-ad5c-668e08adbce0)
// selects the Option A portal-route pattern: the operator runs a one-shot
// HTTP POST, the portal mutates the row, and Paperclip's contract for
// Day-2 onboarding is satisfied without a custom n8n workflow.
//
// Auth:
//   * Shared secret in `KAIRIKOS_INTERNAL_ACTIVITY_KEY` (Vercel project env;
//     set by the operator per [KAIA-3125.B](/KAI/issues/KAIA-3125.B)).
//   * Compared against the `X-Internal-Activity-Key` request header with
//     `crypto.timingSafeEqual` (see `src/lib/activity-key-auth.ts`).
//   * The secret is *distinct* from `PORTAL_API_KEY` per the **Blast radius**
//     lens — leaking the n8n milestone key must not give an attacker the
//     ability to flip `ChatbotClient.state`, and vice versa.
//
// Body:
//   `{ "state": "go-live-pending" | "live" | "paused" | "archived"
//            | "in-progress" | "draft" }`
//   Any other value → HTTP 400 `{ error: "invalid_state" }`. The allowlist
//   extends the schema's documented values with `paused` / `archived` /
//   `draft` for the operator-driven lifecycle.
//
// Idempotency:
//   The route reads the current row first and returns
//   `{ ok: true, changed: false, noop: true, id, state }` (HTTP 200) when
//   the requested state already matches. No row is written. This mirrors
//   the [KAIA-2902.A → KAIA-2902.B → KAIA-2902.C](/KAIA/issues/KAIA-2902)
//   pattern: re-running the same call is safe and observable.
//
// Side effects on a real write:
//   1. `state` is updated to the requested value.
//   2. `goLiveAt` is set to `now()` *iff* the new state is `live` AND the
//      row's prior `goLiveAt` is NULL. This matches the KAIA-1062 self-
//      service contract: the operator's manual flip is the first time the
//      chatbot is marked live.
//   3. `updatedAt` is updated by Prisma's `@updatedAt`.
//   4. WP-14 — the same transaction also mirrors the new state onto
//      ClientProduct.onboardingState for the chatbot product (best-effort;
//      see src/lib/client-product-lifecycle.ts), since that column is now
//      the source of truth for per-product onboarding lifecycle.
// =============================================================================

const CUID_RE = /^c[a-z0-9]{20,40}$/;
const ALLOWED_STATES = new Set([
  'in-progress',
  'go-live-pending',
  'live',
  'paused',
  'archived',
  'draft',
]);

interface StateTransitionRequestBody {
  state?: unknown;
}

interface ParsedStateTransitionRequest {
  state: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  const auth = authenticateActivityKeyRequest(req);
  const authError = activityKeyAuthFailureResponse(auth);
  if (authError) return authError;

  const idParam = ctx?.params?.id;
  if (typeof idParam !== 'string' || !CUID_RE.test(idParam)) {
    return NextResponse.json(
      { error: 'invalid_id', detail: 'id must be a ChatbotClient cuid' },
      { status: 400 },
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

  let body: StateTransitionRequestBody;
  try {
    body = (await req.json()) as StateTransitionRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = parseRequestBody(body);
  if (parsed.ok !== true) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.reason },
      { status: 400 },
    );
  }

  // Read first so we can distinguish "changed" vs "noop" without relying on
  // Prisma's `updateCount`. The check is intentionally post-auth so an
  // unauthenticated probe cannot enumerate client ids.
  const existing = await prisma.chatbotClient.findUnique({
    where: { id: idParam },
    select: { id: true, state: true, goLiveAt: true },
  });
  if (!existing) {
    return NextResponse.json(
      { error: 'not_found', detail: 'clientId does not exist' },
      { status: 404 },
    );
  }

  if (existing.state === parsed.value.state) {
    return NextResponse.json(
      {
        ok: true,
        changed: false,
        noop: true,
        id: existing.id,
        state: existing.state,
        goLiveAt: existing.goLiveAt?.toISOString() ?? null,
      },
      { status: 200 },
    );
  }

  try {
    const data: Prisma.ChatbotClientUpdateInput = {
      state: parsed.value.state,
    };
    if (parsed.value.state === 'live' && existing.goLiveAt === null) {
      data.goLiveAt = new Date();
    }

    // WP-14 — the state write + its ClientProduct mirror commit atomically.
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.chatbotClient.update({
        where: { id: existing.id },
        data,
        select: { id: true, state: true, goLiveAt: true, updatedAt: true },
      });
      await mirrorChatbotStateToClientProduct(
        tx,
        existing.id,
        row.state,
        data.goLiveAt as Date | undefined,
      );
      return row;
    });

    return NextResponse.json(
      {
        ok: true,
        changed: true,
        noop: false,
        id: updated.id,
        state: updated.state,
        goLiveAt: updated.goLiveAt?.toISOString() ?? null,
        updatedAt: updated.updatedAt.toISOString(),
      },
      { status: 200 },
    );
  } catch (err) {
    logError('internal.state_transition', err, {
      route: `POST /api/internal/clients/${existing.id}/state-transition`,
      clientId: existing.id,
      fromState: existing.state,
      toState: parsed.value.state,
    });
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
  | { ok: true; value: ParsedStateTransitionRequest }
  | { ok: false; reason: string };

function parseRequestBody(body: StateTransitionRequestBody): ParseResult {
  const { state } = body;
  if (typeof state !== 'string') {
    return { ok: false, reason: 'state must be a string' };
  }
  if (!ALLOWED_STATES.has(state)) {
    return {
      ok: false,
      reason: `state must be one of ${[...ALLOWED_STATES].join(', ')}`,
    };
  }
  return { ok: true, value: { state } };
}