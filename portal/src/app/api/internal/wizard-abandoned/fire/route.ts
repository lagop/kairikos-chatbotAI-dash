import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';
import {
  WIZARD_STEP_KEYS,
  buildRecoveryEmail,
  isWizardStepKey,
  lastStepHuman as resolveLastStepHuman,
  sendRecoveryEmail,
} from '@/lib/wizard-recovery-email';

// =============================================================================
// POST /api/internal/wizard-abandoned/fire
//
// KAIA-1177 (KAIA-1172 / AU-2) — idempotent write route. Called by the
// n8n `wizard-abandoned` flow for each candidate the scan returned.
//
// On success:
//   1. Upsert a `ChatbotActivity` row with
//      `milestone='wizard_abandoned'` keyed on `(clientId, milestone)`.
//      The dedup constraint is the source of truth — a retry within the
//      same day (or ever, given the migration's
//      `@@unique([clientId, milestone])`) is a no-op.
//   2. Send the Kira-voice v0 recovery email via Resend via
//      `src/lib/wizard-recovery-email.ts`. The route stores the rendered
//      subject + Resend message id (or skip reason) in `notes` for the
//      funnel view in KAIA-1170.
//
// Auth: shared secret via `PORTAL_API_KEY`, fail closed if unset.
//
// Response shape mirrors the runbook §2.2 — `deduped: true` when the
// upsert was a no-op, `resendMessageId: null` when the send was
// deduped OR Resend was skipped (no API key in dev).
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FireRequestBody {
  clientId?: unknown;
  lastDraftAt?: unknown;
  lastStepKey?: unknown;
  hoursSinceLastDraft?: unknown;
}

interface ParsedFireRequest {
  clientId: string;
  lastDraftAt: Date;
  lastStepKey: string;
  hoursSinceLastDraft: number;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to fire',
      },
      { status: 503 },
    );
  }

  let body: FireRequestBody;
  try {
    body = (await req.json()) as FireRequestBody;
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
  // soft-deleted client. The trust boundary is the PORTAL_API_KEY check
  // above (n8n-only).
  const client = await prisma.chatbotClient.findUnique({
    where: { id: parsed.value.clientId },
    select: { id: true, email: true, name: true, companyName: true, state: true },
  });
  if (!client) {
    return NextResponse.json(
      { error: 'not_found', detail: 'clientId does not exist' },
      { status: 404 },
    );
  }

  // Pre-check: if a wizard_abandoned activity row already exists for
  // this client, return deduped=true and skip the Resend call. The
  // migration's `@@unique([clientId, milestone])` is the source of
  // truth but the pre-check avoids the upsert round trip on the
  // common retry path and lets us return the original row unchanged.
  const existing = await prisma.chatbotActivity.findUnique({
    where: {
      clientId_milestone: {
        clientId: parsed.value.clientId,
        milestone: 'wizard_abandoned',
      },
    },
    select: { id: true, completedAt: true, notes: true },
  });

  if (existing) {
    return NextResponse.json({
      ok: true,
      deduped: true,
      id: existing.id,
      clientId: parsed.value.clientId,
      milestone: 'wizard_abandoned',
      lastStepKey: parsed.value.lastStepKey,
      hoursSinceLastDraft: parsed.value.hoursSinceLastDraft,
      sentAt: existing.completedAt ? existing.completedAt.toISOString() : null,
      resendMessageId: extractResendMessageId(existing.notes),
    });
  }

  // Render the email payload so the ChatbotActivity notes column
  // records the exact subject + Resend message id that was sent (or
  // the skip reason in dev with no API key).
  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
  const humanStep = resolveLastStepHuman(parsed.value.lastStepKey);
  const rendered = buildRecoveryEmail({
    clientFirstName: firstNameOf(client.name),
    lastStepKey: parsed.value.lastStepKey,
    lastStepHuman: humanStep,
    hoursSinceLastDraft: Math.round(parsed.value.hoursSinceLastDraft),
    portalUrl,
  });

  // Resolve the contact email. The scan route reports the client's
  // `email` (NextAuth magic-link recipient), which is the same
  // address we send the recovery email to. For internal/operator
  // routing we treat that as the canonical recipient; downstream
  // operators can override the destination at the Resend layer if
  // they need to.
  const recipientEmail = client.email;

  const sent = await sendRecoveryEmail({
    to: recipientEmail,
    clientFirstName: firstNameOf(client.name),
    lastStepKey: parsed.value.lastStepKey,
    lastStepHuman: humanStep,
    hoursSinceLastDraft: Math.round(parsed.value.hoursSinceLastDraft),
    portalUrl,
  });

  if (!sent.ok) {
    return NextResponse.json(
      {
        error: 'resend_send_failed',
        detail: sent.error,
      },
      { status: 502 },
    );
  }

  const completedAt = new Date();
  const notes = JSON.stringify({
    subject: rendered.subject,
    template: rendered.template,
    resendMessageId: sent.messageId,
    lastStepKey: parsed.value.lastStepKey,
    lastStepHuman: humanStep,
    hoursSinceLastDraft: Math.round(parsed.value.hoursSinceLastDraft),
    skipped: 'skipped' in sent ? sent.skipped : undefined,
  });

  try {
    const row = await prisma.chatbotActivity.upsert({
      where: {
        clientId_milestone: {
          clientId: parsed.value.clientId,
          milestone: 'wizard_abandoned',
        },
      },
      create: {
        clientId: parsed.value.clientId,
        milestone: 'wizard_abandoned',
        completedAt,
        notes,
      },
      update: {
        // Idempotent retry: refresh the timestamp + notes (the first
        // send wins for `resendMessageId` — we never overwrite a
        // non-null id with a different one; the unique constraint
        // already prevents the race).
        completedAt,
        notes,
      },
      select: { id: true, completedAt: true, notes: true, milestone: true, clientId: true },
    });

    return NextResponse.json({
      ok: true,
      deduped: false,
      id: row.id,
      clientId: row.clientId,
      milestone: row.milestone,
      lastStepKey: parsed.value.lastStepKey,
      hoursSinceLastDraft: Math.round(parsed.value.hoursSinceLastDraft),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      resendMessageId: sent.messageId,
      skipped: 'skipped' in sent ? sent.skipped : undefined,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 = unique constraint. Treat as dedup; the original row
      // is the one the operator sees. We re-read it so the response
      // matches the runbook's `deduped: true` contract.
      if (err.code === 'P2002') {
        const original = await prisma.chatbotActivity.findUnique({
          where: {
            clientId_milestone: {
              clientId: parsed.value.clientId,
              milestone: 'wizard_abandoned',
            },
          },
          select: { id: true, completedAt: true, notes: true },
        });
        if (original) {
          return NextResponse.json({
            ok: true,
            deduped: true,
            id: original.id,
            clientId: parsed.value.clientId,
            milestone: 'wizard_abandoned',
            lastStepKey: parsed.value.lastStepKey,
            hoursSinceLastDraft: parsed.value.hoursSinceLastDraft,
            completedAt: original.completedAt ? original.completedAt.toISOString() : null,
            resendMessageId: extractResendMessageId(original.notes),
          });
        }
      }
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

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

type ParseResult =
  | { ok: true; value: ParsedFireRequest }
  | { ok: false; reason: string };

function parseRequestBody(body: FireRequestBody): ParseResult {
  const { clientId, lastDraftAt, lastStepKey, hoursSinceLastDraft } = body;

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, reason: 'clientId must be a UUID string' };
  }

  let lastDraftAtDate: Date;
  if (typeof lastDraftAt === 'string') {
    const parsed = new Date(lastDraftAt);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, reason: 'lastDraftAt must be an ISO-8601 string' };
    }
    lastDraftAtDate = parsed;
  } else if (lastDraftAt instanceof Date) {
    lastDraftAtDate = lastDraftAt;
  } else {
    return { ok: false, reason: 'lastDraftAt must be an ISO-8601 string' };
  }

  if (typeof lastStepKey !== 'string' || !isWizardStepKey(lastStepKey)) {
    return {
      ok: false,
      reason: `lastStepKey must be one of ${WIZARD_STEP_KEYS.join(', ')}`,
    };
  }

  if (
    typeof hoursSinceLastDraft !== 'number' ||
    !Number.isFinite(hoursSinceLastDraft) ||
    hoursSinceLastDraft < 0
  ) {
    return {
      ok: false,
      reason: 'hoursSinceLastDraft must be a non-negative number',
    };
  }

  return {
    ok: true,
    value: {
      clientId,
      lastDraftAt: lastDraftAtDate,
      lastStepKey,
      hoursSinceLastDraft,
    },
  };
}

function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return 'cliente';
  const trimmed = fullName.trim();
  if (!trimmed) return 'cliente';
  return trimmed.split(/\s+/, 1)[0] ?? 'cliente';
}

/**
 * Pull the `resendMessageId` back out of the notes JSON. The fire
 * route writes `{ subject, template, resendMessageId, ... }` so a
 * deduped retry can report the original message id without an extra
 * round trip.
 */
function extractResendMessageId(notes: string | null): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as { resendMessageId?: unknown };
    return typeof parsed.resendMessageId === 'string'
      ? parsed.resendMessageId
      : null;
  } catch {
    return null;
  }
}
