import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  INTAKE_SLUG,
  deriveVertical,
  parseIntakePayload,
  type IntakePayload,
} from '@/lib/intake-schema';
import { createClientFolderAndUploadKit } from '@/lib/google-drive';
import { createDay2OnboardingIssue } from '@/lib/paperclip-day2';
import { notifyOperatorOfExecutionFailure } from '@/lib/operator-notify';

// =============================================================================
// POST /api/public/intake — KAIA-2913
//
// Public-facing intake endpoint that replaces the Tally webhook ingestion.
// Reachable from the in-house portal form on kairikos.com. The endpoint:
//
//   1. Validates the JSON body with the Zod schema derived from
//      tally-form-spec.json (webhook_payload_schema, v1.0.0). Returns 400
//      with a flat field-error list on validation failure.
//
//   2. Resolves the X-Idempotency-Key header (or mints a UUIDv4 fallback).
//      If an existing IntakeSubmission already carries that key, the route
//      returns the previous response shape (200, no-op) so retries never
//      create duplicate ChatbotClient / ChatbotClientUser / Drive folder
//      / CTO email / Paperclip issue. The DB unique index on
//      `idempotency_key` is the safety net for racing concurrent retries.
//
//   3. Upserts ChatbotClient (idempotency on email) and ChatbotClientUser
//      in a transaction. The intake starts every client in tier='starter'
//      state='in-progress' until Stripe assigns a tier; the wizard
//      onboarding flow takes over from there.
//
//   4. Creates the IntakeSubmission row with the resolved clientId, plus
//      a SHA-256 of the request IP (raw IP never stored) and the user
//      agent for the operator forensics view.
//
//   5. Fires Drive folder creation (best-effort, never blocks the
//      response), notifies the operator / CEO via the existing
//      notify-operator internal endpoint with kind='escalation' semantics,
//      and creates the Paperclip Day-2 issue for the Automation Engineer.
//
//   6. Returns 200 with { ok: true, submissionId, clientId, vertical }.
//
// Auth: the endpoint is public. Rate limiting is delegated to the edge
// (Vercel firewall / Cloudflare); the route refuses any payload over 64 KB
// to bound memory.
//
// Logging: structured JSON to stdout. No raw payload (PII redaction lives
// in the log helper).
// =============================================================================

const MAX_BODY_BYTES = 64 * 1024; // 64 KB hard cap
const DEFAULT_TIER = 'starter';
const DEFAULT_STATE = 'in-progress';

interface FinalResponse {
  ok: true;
  submissionId: string;
  clientId: string;
  clientUserId: string;
  vertical: string;
  idempotencyKey: string;
  drive?: { folderId?: string; folderUrl?: string; skipped?: string };
  day2Issue?: { issueIdentifier?: string; skipped?: string };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();

  // ---- 0. body size guard --------------------------------------------------
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: 'payload_too_large', detail: `max ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to accept intake',
      },
      { status: 503 },
    );
  }

  // ---- 1. parse + validate -------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = parseIntakePayload(rawBody);
  if (!parsed.ok || !parsed.data) {
    return NextResponse.json(
      {
        error: 'validation_failed',
        detail: 'payload failed intake schema',
        errors: parsed.errors ?? [],
      },
      { status: 400 },
    );
  }

  const payload = parsed.data as IntakePayload;
  const vertical = deriveVertical(payload.sector);

  // ---- 2. idempotency ------------------------------------------------------
  const idempotencyKey =
    (req.headers.get('x-idempotency-key') ?? '').trim() || randomUUID();

  const existing = await prisma.intakeSubmission.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      clientId: true,
      vertical: true,
      payload: true,
    },
  });

  if (existing && existing.clientId) {
    // Replay path — return the previous response shape without re-firing
    // any side effects. The (idempotency_key) UNIQUE index guarantees a
    // single IntakeSubmission row per key.
    const replay: FinalResponse = {
      ok: true,
      submissionId: existing.id,
      clientId: existing.clientId,
      clientUserId: '', // unknown on replay; lookup not required
      vertical: existing.vertical,
      idempotencyKey,
      drive: { skipped: 'replay' },
      day2Issue: { skipped: 'replay' },
    };
    logIntake('intake.replay', { idempotencyKey, submissionId: existing.id });
    return NextResponse.json(replay, { status: 200 });
  }

  // ---- 3. upsert client + clientUser in a transaction ---------------------
  const ipHash = hashIp(req);
  const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 400) || null;

  const client = await prisma.$transaction(async (tx) => {
    // ChatbotClient.email is the unique join — first write wins, second
    // write reuses the row (same business owner).
    const existingClient = await tx.chatbotClient.findUnique({
      where: { email: payload.human_handoff_email },
      select: { id: true, name: true, companyName: true },
    });

    const clientRecord = existingClient
      ? await tx.chatbotClient.update({
          where: { id: existingClient.id },
          data: {
            companyName: payload.business_name,
            // Don't overwrite tier/state — Stripe webhook owns those.
          },
          select: { id: true, name: true, companyName: true },
        })
      : await tx.chatbotClient.create({
          data: {
            email: payload.human_handoff_email,
            name: payload.business_name,
            companyName: payload.business_name,
            tier: DEFAULT_TIER,
            state: DEFAULT_STATE,
          },
          select: { id: true, name: true, companyName: true },
        });

    // ChatbotClientUser.nextAuthEmail is UNIQUE — upsert.
    const clientUser = await tx.chatbotClientUser.upsert({
      where: { nextAuthEmail: payload.human_handoff_email },
      update: { clientId: clientRecord.id },
      create: {
        nextAuthEmail: payload.human_handoff_email,
        clientId: clientRecord.id,
      },
      select: { id: true },
    });

    // IntakeSubmission — UNIQUE on idempotency_key, so on race the second
    // insert collapses to a no-op via a follow-up findUnique.
    try {
      const submission = await tx.intakeSubmission.create({
        data: {
          idempotencyKey,
          source: 'public_intake',
          vertical,
          intakeSlug: INTAKE_SLUG,
          payload: payload as unknown as object,
          clientId: clientRecord.id,
          businessName: payload.business_name,
          humanHandoffEmail: payload.human_handoff_email,
          ipHash,
          userAgent,
        },
        select: { id: true },
      });

      return {
        clientId: clientRecord.id,
        clientUserId: clientUser.id,
        submissionId: submission.id,
      };
    } catch (err) {
      // P2002 (unique violation) on idempotency_key — a concurrent retry
      // already inserted. Fall back to reading the existing row.
      if (isUniqueViolation(err)) {
        const winner = await tx.intakeSubmission.findUnique({
          where: { idempotencyKey },
          select: { id: true, clientId: true },
        });
        if (winner && winner.clientId) {
          return {
            clientId: winner.clientId,
            clientUserId: clientUser.id,
            submissionId: winner.id,
          };
        }
      }
      throw err;
    }
  });

  logIntake('intake.persisted', {
    submissionId: client.submissionId,
    clientId: client.clientId,
    vertical,
    business: payload.business_name,
  });

  // ---- 4. fire side effects in parallel (best-effort) ----------------------
  // The route returns 200 once the DB write commits. Drive / notify /
  // Paperclip each have their own failure mode — they never block the
  // response, never duplicate effects (the operator can retry from the
  // admin panel). The DB row is the source of truth for follow-up.
  const drivePromise = createClientFolderAndUploadKit({
    businessName: payload.business_name,
    intakePayload: payload,
  }).catch((err) => ({
    ok: false,
    skipped: 'api_error' as const,
    error: (err as Error).message,
  }));

  // Notify the operator via the existing internal endpoint. We treat
  // notify-operator as the canonical CEO-email channel; if it fails, we
  // surface that in the response so the operator sees a degraded run.
  const notifyPromise = notifyOperatorOfIntake({
    clientId: client.clientId,
    businessName: payload.business_name,
    vertical,
    submissionId: client.submissionId,
    humanHandoffEmail: payload.human_handoff_email,
  }).catch((err) => ({
    ok: false,
    error: (err as Error).message,
  }));

  // Paperclip Day-2 issue — assigned to the Automation Engineer.
  const day2Promise = createDay2OnboardingIssue({
    clientName: payload.business_name,
    vertical,
    clientId: client.clientId,
    humanHandoffEmail: payload.human_handoff_email,
    intakeSubmissionId: client.submissionId,
  }).catch((err) => ({
    ok: false,
    skipped: 'api_error' as const,
    error: (err as Error).message,
  }));

  const [drive, notify, day2] = await Promise.all([
    drivePromise,
    notifyPromise,
    day2Promise,
  ]);

  // Normalize the result shapes — the .catch() wrappers return different
  // (narrower) shapes than the happy-path result types. Coerce them to
  // the canonical shape so the rest of the function can treat them
  // uniformly.
  const driveResult = normalizeDriveResult(drive);
  const day2Result = normalizeDay2Result(day2);

  if (!driveResult.ok) {
    logIntake('intake.drive.failed', {
      submissionId: client.submissionId,
      error: driveResult.error,
    });
    // WP-26 — "sincronización de Google fallida" is one of the three
    // named critical flows for the alert requirement. logIntake() above
    // already put this in the structured log stream; this is the part
    // that actually reaches a human instead of waiting for one to go
    // looking. `skipped: 'not_configured'` is the expected shape in any
    // env without Drive OAuth set up (e.g. most non-prod deploys) — that
    // one case is deliberately not alerted on, everything else is.
    if (driveResult.skipped !== 'not_configured') {
      void notifyOperatorOfExecutionFailure({
        executionId: client.submissionId,
        workflowName: 'intake_drive_provisioning',
        error: driveResult.error ?? `skipped: ${driveResult.skipped ?? 'unknown'}`,
        clientId: client.clientId,
      }).catch(() => {
        // Best-effort — logIntake above already guarantees this isn't silent.
      });
    }
  }
  if (!notify.ok) {
    logIntake('intake.notify.failed', {
      submissionId: client.submissionId,
      error: notify.error,
    });
  }
  if (!day2Result.ok) {
    logIntake('intake.day2.failed', {
      submissionId: client.submissionId,
      error: day2Result.error,
    });
  }

  // ---- 5. response ---------------------------------------------------------
  const response: FinalResponse = {
    ok: true,
    submissionId: client.submissionId,
    clientId: client.clientId,
    clientUserId: client.clientUserId,
    vertical,
    idempotencyKey,
    drive: driveResult.ok
      ? { folderId: driveResult.folderId, folderUrl: driveResult.folderUrl }
      : { skipped: driveResult.skipped ?? 'api_error' },
    day2Issue: day2Result.ok
      ? { issueIdentifier: day2Result.issueIdentifier }
      : { skipped: day2Result.skipped ?? 'api_error' },
  };

  logIntake('intake.done', {
    submissionId: client.submissionId,
    clientId: client.clientId,
    elapsedMs: Date.now() - startedAt,
    driveOk: drive.ok,
    notifyOk: notify.ok,
    day2Ok: day2.ok,
  });

  return NextResponse.json(response, { status: 200 });
}

export function GET() {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { allow: 'POST' } },
  );
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Helpers
// =============================================================================

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002',
  );
}

function hashIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = (forwarded?.split(',')[0] ?? '').trim();
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

type DriveResultNormalized =
  | { ok: true; folderId?: string; folderUrl?: string }
  | { ok: false; skipped?: string; error: string };

function normalizeDriveResult(value: unknown): DriveResultNormalized {
  if (
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    (value as { ok: boolean }).ok === true
  ) {
    const v = value as {
      folderId?: string;
      folderUrl?: string;
      uploadedFiles?: unknown;
    };
    return {
      ok: true,
      folderId: v.folderId,
      folderUrl: v.folderUrl,
    };
  }
  const v = value as { skipped?: string; error?: string } | undefined;
  return {
    ok: false,
    skipped: v?.skipped,
    error: v?.error ?? 'unknown drive error',
  };
}

type Day2ResultNormalized =
  | { ok: true; issueIdentifier?: string }
  | { ok: false; skipped?: string; error: string };

function normalizeDay2Result(value: unknown): Day2ResultNormalized {
  if (
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    (value as { ok: boolean }).ok === true
  ) {
    const v = value as { issueId?: string; issueIdentifier?: string };
    return { ok: true, issueIdentifier: v.issueIdentifier };
  }
  const v = value as { skipped?: string; error?: string } | undefined;
  return {
    ok: false,
    skipped: v?.skipped,
    error: v?.error ?? 'unknown day2 error',
  };
}

function logIntake(event: string, fields: Record<string, unknown>): void {
  // Structured single-line JSON — Vercel log drain / Datadog ingests this
  // shape. We deliberately exclude PII (email, business_name) except where
  // it's the explicit subject (intake.done carries business as a count).
  const safe: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  if ('humanHandoffEmail' in safe) delete safe.humanHandoffEmail;
  if ('business' in safe) delete safe.business;
  console.log(JSON.stringify({ source: 'public_intake', ...safe }));
}

interface NotifyArgs {
  clientId: string;
  businessName: string;
  vertical: string;
  submissionId: string;
  humanHandoffEmail: string;
}

async function notifyOperatorOfIntake(args: NotifyArgs): Promise<{
  ok: boolean;
  error?: string;
}> {
  // KAIA-11955 — production PORTAL_API_BASE_URL ends in `/portal`
  // (the SPA path) but the route handlers live at `/api/...`. Build the
  // API URL by stripping the trailing `/portal` so the request hits
  // `${origin}/api/internal/notify-operator` instead of the
  // 404-producing `${origin}/portal/api/internal/notify-operator`.
  const internalUrl = process.env.PORTAL_API_BASE_URL
    ? (() => {
        const stripped = process.env.PORTAL_API_BASE_URL!.replace(/\/$/, '').replace(
          /\/portal$/,
          '',
        );
        return `${stripped}/api/internal/notify-operator`;
      })()
    : null;
  const portalApiKey = process.env.PORTAL_API_KEY;

  if (!internalUrl || !portalApiKey) {
    return {
      ok: false,
      error:
        'PORTAL_API_BASE_URL or PORTAL_API_KEY not set; cannot notify operator',
    };
  }

  const res = await fetch(internalUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kairikos-internal-key': portalApiKey,
    },
    body: JSON.stringify({
      kind: 'escalation',
      clientId: args.clientId,
      reason: `Nuevo intake público: ${args.businessName} (vertical=${args.vertical}). Submission ${args.submissionId}. Email handoff: ${args.humanHandoffEmail}`,
      status: 'intake_received',
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      error: `notify-operator returned ${res.status}`,
    };
  }

  return { ok: true };
}