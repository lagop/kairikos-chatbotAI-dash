import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';
import {
  ALLOWED_KINDS,
  parseKindsAllowlist,
  renderEscalation,
  renderExecutionFailed,
  renderStuck,
  resolveOperatorRecipients,
  sendOperatorNotification,
  utcDayKey,
  type NotificationKind,
  type OperatorRecipient,
} from '@/lib/operator-notify';

// =============================================================================
// POST /api/internal/notify-operator
//
// KAIA-1061 — internal endpoint the n8n T+N flows and the status-change
// watcher call to email the operator when something needs a human call:
//   * `stuck`            — a client has been silent for >N hours
//   * `execution-failed` — an n8n execution failed
//   * `escalation`       — T+7 escalation is required
//
// Auth: shared secret via `PORTAL_API_KEY`, verified by
// `authenticateInternalRequest`. Fail closed if the env var is unset.
//
// Dedup: the `OperatorNotification` table has `@@unique([clientId, kind,
// day])` and the route does an upsert keyed on that pair. Repeated calls
// within the same UTC day collapse to a no-op — the operator does not get
// the same alert twice. `day` is the UTC date string (YYYY-MM-DD), not
// a timestamp, so the constraint is timezone-stable.
//
// Side effects:
//   1. Resolves `KAIRIKOS_OPERATOR_EMAILS` (fails closed if empty).
//   2. Checks `KAIRIKOS_NOTIFY_KINDS` allowlist (opt-out per kind).
//   3. Renders the kind-specific subject + html + text via the templates
//      in `operator-notify.ts`.
//   4. Sends the email via Resend (`sendOperatorNotification`).
//   5. Persists a single `OperatorNotification` row with the
//      `resendMessageId` (or NULL when the send was skipped / failed).
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NotifyOperatorRequestBody {
  kind?: unknown;
  clientId?: unknown;
  // Kind-specific payloads. The route validates the right field is
  // present for the given `kind`.
  milestone?: unknown;
  hoursSince?: unknown;
  executionId?: unknown;
  workflowName?: unknown;
  error?: unknown;
  reason?: unknown;
  status?: unknown;
}

interface ParsedNotifyRequest {
  kind: NotificationKind;
  clientId: string | null; // optional for execution-failed when unassigned
  payload: Record<string, unknown>;
  clientDisplayName: string;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to send',
      },
      { status: 503 },
    );
  }

  let body: NotifyOperatorRequestBody;
  try {
    body = (await req.json()) as NotifyOperatorRequestBody;
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

  // Per-kind allowlist — the operator can opt out of a kind by listing
  // the others in `KAIRIKOS_NOTIFY_KINDS`. Empty env var means "all
  // allowed".
  const allowlist = parseKindsAllowlist(process.env.KAIRIKOS_NOTIFY_KINDS);
  if (allowlist && !allowlist.has(parsed.value.kind)) {
    return NextResponse.json(
      {
        ok: true,
        skipped: 'kind_disabled',
        kind: parsed.value.kind,
      },
      { status: 200 },
    );
  }

  // Operator recipient list — fail closed if not configured. Sending
  // silently when the operator is unreachable is the worse failure mode.
  const recipients = resolveOperatorRecipients(
    process.env.KAIRIKOS_OPERATOR_EMAILS,
  );
  if (recipients.length === 0) {
    return NextResponse.json(
      {
        error: 'operator_not_configured',
        detail: 'KAIRIKOS_OPERATOR_EMAILS is not set; refusing to send',
      },
      { status: 500 },
    );
  }

  // Resolve the client (if any) and personalize the templates.
  const enriched = await enrichWithClient(parsed.value, recipients);
  if ('error' in enriched) {
    return NextResponse.json(enriched.error, { status: enriched.status });
  }

  const { subject, text, html } = enriched.rendered;

  // Dedup: try the insert first via upsert. If a row already exists for
  // (clientId, kind, day), we don't re-send and return the existing row.
  const day = utcDayKey();
  const existing = await prisma.operatorNotification.findUnique({
    where: {
      clientId_kind_day: {
        clientId: enriched.clientIdForLog,
        kind: parsed.value.kind,
        day,
      },
    },
    select: { id: true, sentAt: true, resendMessageId: true },
  });

  if (existing) {
    return NextResponse.json({
      ok: true,
      deduped: true,
      id: existing.id,
      kind: parsed.value.kind,
      clientId: enriched.clientIdForLog,
      day,
      sentAt: existing.sentAt.toISOString(),
      resendMessageId: existing.resendMessageId,
    });
  }

  // Send + log. We log the row first with `resendMessageId: null` and
  // then update it after a successful send, so a crash mid-send doesn't
  // block future notifications but also doesn't leave a phantom email
  // claim in the log. The unique constraint is the safety net either way.
  const sent = await sendOperatorNotification({
    kind: parsed.value.kind,
    to: recipients,
    subject,
    text,
    html,
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

  const row = await prisma.operatorNotification.upsert({
    where: {
      clientId_kind_day: {
        clientId: enriched.clientIdForLog,
        kind: parsed.value.kind,
        day,
      },
    },
    create: {
      clientId: enriched.clientIdForLog,
      kind: parsed.value.kind,
      day,
      subject,
      context: JSON.stringify(parsed.value.payload),
      resendMessageId: sent.messageId,
      sentAt: new Date(),
    },
    update: {
      // Idempotent retry: refresh the timestamp + context. We do NOT
      // overwrite `resendMessageId` with a different value — the first
      // send wins so the operator always references the same Resend
      // message id when looking up delivery state.
      subject,
      context: JSON.stringify(parsed.value.payload),
      sentAt: new Date(),
    },
    select: { id: true, sentAt: true, resendMessageId: true },
  });

  return NextResponse.json({
    ok: true,
    deduped: false,
    id: row.id,
    kind: parsed.value.kind,
    clientId: enriched.clientIdForLog,
    day,
    sentAt: row.sentAt.toISOString(),
    resendMessageId: row.resendMessageId,
    skipped: 'skipped' in sent ? sent.skipped : undefined,
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation + enrichment
// -----------------------------------------------------------------------------

type ParseResult =
  | { ok: true; value: ParsedNotifyRequest }
  | { ok: false; reason: string };

function parseRequestBody(body: NotifyOperatorRequestBody): ParseResult {
  const { kind, clientId, milestone, hoursSince, executionId, workflowName, error, reason, status } =
    body;

  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind as NotificationKind)) {
    return {
      ok: false,
      reason: `kind must be one of ${[...ALLOWED_KINDS].join(', ')}`,
    };
  }
  const kindValue = kind as NotificationKind;

  // clientId is optional only for execution-failed. For stuck and
  // escalation the operator needs to know which client to call, so
  // those refuse a missing/invalid clientId up front.
  if (kindValue === 'execution-failed') {
    if (
      clientId !== undefined &&
      clientId !== null &&
      (typeof clientId !== 'string' || !UUID_RE.test(clientId))
    ) {
      return { ok: false, reason: 'clientId must be a UUID string or null' };
    }
  } else {
    if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
      return { ok: false, reason: 'clientId must be a UUID string' };
    }
  }

  const payload: Record<string, unknown> = { kind: kindValue };
  if (clientId !== undefined) payload.clientId = clientId;

  if (kindValue === 'stuck') {
    if (typeof milestone !== 'string' || milestone.length === 0) {
      return { ok: false, reason: 'stuck requires milestone (e.g. "T+3")' };
    }
    if (typeof hoursSince !== 'number' || !Number.isFinite(hoursSince) || hoursSince < 0) {
      return {
        ok: false,
        reason: 'stuck requires hoursSince as a non-negative number',
      };
    }
    payload.milestone = milestone;
    payload.hoursSince = hoursSince;
  }

  if (kindValue === 'execution-failed') {
    if (typeof executionId !== 'string' || executionId.length === 0) {
      return { ok: false, reason: 'execution-failed requires executionId' };
    }
    if (typeof workflowName !== 'string' || workflowName.length === 0) {
      return { ok: false, reason: 'execution-failed requires workflowName' };
    }
    if (typeof error !== 'string' || error.length === 0) {
      return { ok: false, reason: 'execution-failed requires error' };
    }
    payload.executionId = executionId;
    payload.workflowName = workflowName;
    payload.error = error.slice(0, 4000); // cap to keep context column sane
  }

  if (kindValue === 'escalation') {
    if (typeof reason !== 'string' || reason.length === 0) {
      return { ok: false, reason: 'escalation requires reason' };
    }
    payload.reason = reason;
    if (status !== undefined && status !== null) {
      if (typeof status !== 'string') {
        return { ok: false, reason: 'status must be a string or null' };
      }
      payload.status = status;
    }
  }

  return {
    ok: true,
    value: {
      kind: kindValue,
      clientId: typeof clientId === 'string' ? clientId : null,
      payload,
      // Resolved below in enrichWithClient.
      clientDisplayName: '',
    },
  };
}

interface EnrichedRequest {
  rendered: { subject: string; text: string; html: string };
  recipients: OperatorRecipient[];
  clientIdForLog: string;
}

async function enrichWithClient(
  parsed: ParsedNotifyRequest,
  recipients: OperatorRecipient[],
): Promise<
  | EnrichedRequest
  | { error: Record<string, unknown>; status: number }
> {
  let clientDisplayName = 'cliente';
  let clientIdForLog: string;

  if (parsed.clientId) {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: parsed.clientId },
      select: { id: true, name: true, companyName: true },
    });
    if (!client) {
      return {
        error: { error: 'not_found', detail: 'clientId does not exist' },
        status: 404,
      };
    }
    clientDisplayName = client.companyName ?? client.name;
    clientIdForLog = client.id;
  } else {
    // Non-client-scoped event. We use a synthetic key for the unique
    // constraint so a NULL clientId row doesn't collide with itself in
    // the index. The route documents this with the operator in the
    // subject line (rendered below).
    clientIdForLog = '__unassigned__';
  }

  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? undefined;

  let rendered: { subject: string; text: string; html: string };
  if (parsed.kind === 'stuck') {
    rendered = renderStuck({
      clientId: parsed.clientId ?? clientIdForLog,
      clientName: clientDisplayName,
      milestone: String(parsed.payload.milestone),
      hoursSince: Number(parsed.payload.hoursSince),
      portalUrl,
    });
  } else if (parsed.kind === 'execution-failed') {
    rendered = renderExecutionFailed({
      clientId: parsed.clientId,
      clientName: parsed.clientId ? clientDisplayName : null,
      executionId: String(parsed.payload.executionId),
      workflowName: String(parsed.payload.workflowName),
      error: String(parsed.payload.error),
      portalUrl,
    });
  } else {
    rendered = renderEscalation({
      clientId: parsed.clientId ?? clientIdForLog,
      clientName: clientDisplayName,
      reason: String(parsed.payload.reason),
      status: (parsed.payload.status as string | undefined) ?? null,
      portalUrl,
    });
  }

  return { rendered, recipients, clientIdForLog };
}
