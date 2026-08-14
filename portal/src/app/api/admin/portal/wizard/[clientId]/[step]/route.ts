import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  applyWizardReview,
  getWizardStepReview,
  WizardReviewError,
  type WizardReviewAction,
} from '@/lib/wizard-review';
import {
  parseStepNumber,
  getStepDefinition,
  normalizeTier,
  CHATBOT_PRODUCT_CODE,
  type WizardStepNumber,
  type WizardTier,
} from '@/lib/wizard-catalog';
import { resolveOperatorStep } from '@/lib/wizard-visibility';
import { jsonToObject } from '@/lib/wizard-tier-prisma';
import { PRODUCT_CODES, type ProductCode } from '@/lib/catalogs';

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

// =============================================================================
// KAIA-1165 (BE-3) + KAIA-1166 (BE-4) — Operator wizard review.
//
//   GET  /api/admin/portal/wizard/[clientId]/[step]
//   PATCH /api/admin/portal/wizard/[clientId]/[step]
//
// GET returns the client summary, every persisted version of the
// (clientId, stepKey) row, and the most recent operator audit entries for
// the operator review UI (KAIA-1169). BE-4 adds the tier-aware companion
// block: `effectivePayload` (what the bot is running on), `savedPayload`
// (cliente's submission), `defaultPayload` (catalog), `autoConfigured`
// (true when the cliente is on Starter safety rails), and `editable` (false
// for Step 12 in v1).
//
// PATCH is the operator decision endpoint. Body:
//   { action: "approve" | "request_revision", comment?: string }
//
// - approve: latest submitted version becomes status='approved',
//   activeForBot=true, approvedByOperatorId=operatorId. If a previous row
//   was activeForBot=true, that row is flipped to false and a
//   'deactivate' audit row is written. Two audit rows are written for the
//   approved version: 'approve' (operator) and 'activate' (system).
//   Step 12 (v1.1) cannot be approved; the operator PATCH is rejected
//   with 409.
// - request_revision: latest version (regardless of prior status) becomes
//   status='needs_revision'. `comment` is required. One audit row:
//   'request_revision'.
//
// Auth: operator session cookie OR legacy `x-kaia-operator-key` header.
// =============================================================================

const STEP_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

const ALLOWED_ACTIONS: ReadonlySet<WizardReviewAction> = new Set<WizardReviewAction>([
  'approve',
  'request_revision',
]);

const MAX_COMMENT_LENGTH = 2000;

interface PatchBody {
  action?: unknown;
  comment?: unknown;
}

interface ReviewErrorBody {
  error: string;
  detail?: string;
}

function errorResponse(error: string, status: number, detail?: string) {
  const body: ReviewErrorBody = detail ? { error, detail } : { error };
  return NextResponse.json(body, { status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { clientId: string; step: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const { clientId, step } = params;
  if (!STEP_KEY_RE.test(step)) {
    return errorResponse('bad_request', 400, 'step must match [a-z0-9_-]{1,64}');
  }

  const productCodeRaw = req.nextUrl.searchParams.get('productCode') ?? CHATBOT_PRODUCT_CODE;
  if (!isProductCode(productCodeRaw)) {
    return errorResponse('bad_request', 400, 'unknown productCode');
  }
  const productCode = productCodeRaw;

  const data = await getWizardStepReview(prisma, clientId, productCode, step);
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // BE-4: compute the tier-aware companion view. `parseStepNumber` /
  // `getStepDefinition` are chatbot's numbered-step catalog — the other
  // four products have no step catalog yet (see @/lib/catalogs), so the
  // companion block only applies to the chatbot product.
  let stepNumber: WizardStepNumber | null = null;
  let companionBlock: Record<string, unknown> | null = null;
  try {
    if (productCode !== CHATBOT_PRODUCT_CODE) {
      throw new Error('companion block only applies to the chatbot product');
    }
    stepNumber = parseStepNumber(step);
    const def = getStepDefinition(stepNumber);
    const clientTier: WizardTier | null = normalizeTier(data.client.tier);
    // Use the latest version's payload (matches the BE-2 cliente view).
    // `data.versions` is newest-first; the [0] is the latest.
    const latestRow = data.versions[0];
    const savedPayload = jsonToObject(
      (latestRow?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
    );
    const resolved = resolveOperatorStep(
      stepNumber,
      clientId,
      clientTier,
      {
        hasSavedVersion: !!latestRow,
        status: latestRow?.status,
        submittedAt: latestRow?.submittedAt?.toISOString() ?? null,
        approvedAt: latestRow?.approvedAt?.toISOString() ?? null,
        activeForBot: latestRow?.activeForBot,
      },
      savedPayload,
    );
    companionBlock = {
      number: def.number,
      key: def.key,
      label: def.label,
      block: def.block,
      v11Deferred: def.v11Deferred,
      editable: !def.v11Deferred,
      clientTier,
      clienteVisibleForTier: resolved.clienteVisibleForTier,
      autoConfigured: resolved.autoConfigured,
      effectivePayload: resolved.effectivePayload,
      savedPayload: resolved.savedPayload,
      defaultPayload: resolved.defaultPayload,
    };
  } catch {
    // If the stepKey doesn't match the catalog (defensive), we still
    // return the BE-3 payload without the companion block. This is
    // fine because the BE-3 [step] route uses a more permissive
    // regex; future BE-4 endpoints will use the strict catalog.
  }

  return NextResponse.json({
    client: {
      id: data.client.id,
      name: data.client.name,
      companyName: data.client.companyName,
      email: data.client.email,
      tier: data.client.tier,
      state: data.client.state,
      goLiveAt: data.client.goLiveAt?.toISOString() ?? null,
    },
    versions: data.versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      payload: v.payload,
      submittedAt: v.submittedAt?.toISOString() ?? null,
      approvedAt: v.approvedAt?.toISOString() ?? null,
      approvedByOperatorId: v.approvedByOperatorId,
      activeForBot: v.activeForBot,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
    auditLogs: data.auditLogs.map((a) => ({
      id: a.id,
      stepId: a.stepId,
      version: a.version,
      actor: a.actor,
      actorId: a.actorId,
      action: a.action,
      comment: a.comment,
      createdAt: a.createdAt.toISOString(),
    })),
    ...(companionBlock ? { tierView: companionBlock } : {}),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { clientId: string; step: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (auth.operatorId === 'legacy') {
    return errorResponse('forbidden', 403, 'legacy key auth cannot approve steps');
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const { clientId, step } = params;
  if (!STEP_KEY_RE.test(step)) {
    return errorResponse('bad_request', 400, 'step must match [a-z0-9_-]{1,64}');
  }

  const productCodeRaw = req.nextUrl.searchParams.get('productCode') ?? CHATBOT_PRODUCT_CODE;
  if (!isProductCode(productCodeRaw)) {
    return errorResponse('bad_request', 400, 'unknown productCode');
  }
  const productCode = productCodeRaw;

  // BE-4 gate: Step 12 is v1.1 deferred and cannot be approved /
  // sent-back through the operator flow. Surface a clear 409. This gate
  // only applies to the chatbot's numbered-step catalog; other products
  // have no step catalog yet to check against.
  if (productCode === CHATBOT_PRODUCT_CODE) {
    try {
      const stepNumber = parseStepNumber(step);
      const def = getStepDefinition(stepNumber);
      if (def.v11Deferred) {
        return errorResponse(
          'conflict',
          409,
          'step 12 is deferred to v1.1; the operator cannot approve it in v1',
        );
      }
    } catch {
      return errorResponse('bad_request', 400, 'step must be a string from the allowlist');
    }
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return errorResponse('bad_request', 400, 'body must be valid JSON');
  }

  if (typeof body.action !== 'string' || !ALLOWED_ACTIONS.has(body.action as WizardReviewAction)) {
    return errorResponse(
      'bad_request',
      400,
      'action must be "approve" or "request_revision"',
    );
  }
  const action = body.action as WizardReviewAction;

  if (body.comment !== undefined && typeof body.comment !== 'string') {
    return errorResponse('bad_request', 400, 'comment must be a string');
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim() : undefined;
  if (comment && comment.length > MAX_COMMENT_LENGTH) {
    return errorResponse(
      'bad_request',
      400,
      `comment must be at most ${MAX_COMMENT_LENGTH} characters`,
    );
  }

  const operator = await prisma.operator.findUnique({
    where: { id: auth.operatorId },
    select: { id: true, email: true, isActive: true },
  });
  if (!operator || !operator.isActive) {
    return errorResponse('forbidden', 403, 'operator is not active');
  }

  try {
    const result = await applyWizardReview(
      prisma,
      { clientId, productCode, stepKey: step, action, comment },
      { operatorId: operator.id, email: operator.email },
    );
    return NextResponse.json({
      stepId: result.stepId,
      version: result.version,
      status: result.status,
      activeForBot: result.activeForBot,
      approvedByOperatorId: result.approvedByOperatorId,
      approvedAt: result.approvedAt?.toISOString() ?? null,
      deactivatedStepIds: result.deactivatedStepIds,
    });
  } catch (err) {
    if (err instanceof WizardReviewError) {
      switch (err.error.code) {
        case 'client_not_found':
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        case 'step_not_found':
          return NextResponse.json(
            { error: 'not_found', detail: 'no saved version for this step yet' },
            { status: 404 },
          );
        case 'invalid_state_for_approve':
          return errorResponse(
            'conflict',
            409,
            'latest version is not in submitted state; nothing to approve',
          );
        case 'comment_required':
          return errorResponse(
            'bad_request',
            400,
            'comment is required for request_revision',
          );
        case 'comment_too_long':
          return errorResponse(
            'bad_request',
            400,
            `comment must be at most ${MAX_COMMENT_LENGTH} characters`,
          );
      }
    }
    console.error('[PATCH /api/admin/portal/wizard/[clientId]/[step]]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
