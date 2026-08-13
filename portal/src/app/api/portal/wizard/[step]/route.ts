import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  readWizardStep,
  saveWizardStep,
  WizardClientError,
  type WizardStepStatus,
} from '@/lib/wizard-client';
import {
  parseStepNumber,
  getStepDefinition,
  normalizeTier,
  CHATBOT_PRODUCT_CODE,
  type WizardStepNumber,
  type WizardTier,
} from '@/lib/wizard-catalog';
import { resolveClientStep } from '@/lib/wizard-visibility';
import {
  readLatestStepForClient,
  jsonToObject,
} from '@/lib/wizard-tier-prisma';

// =============================================================================
// KAIA-1164 (BE-2) + KAIA-1166 (BE-4) — Client wizard.
//
//   GET  /api/portal/wizard/[step]   — latest + activeForBot row for the
//                                       authenticated client + stepKey,
//                                       tier-augmented with
//                                       `effectivePayload` + `autoConfigured`
//                                       (BE-4 layer). For hidden steps
//                                       (3 / 7 for Starter; 12 always), the
//                                       effective payload falls back to the
//                                       catalog default so the bot can be
//                                       constructed without a saved version.
//   PATCH /api/portal/wizard/[step]  — save a new version
//                                       (status='draft' for autosave,
//                                        status='submitted' for explicit
//                                        "Submit for review").
//                                       Rejected with 403 when the step is
//                                       hidden for the cliente's tier (the
//                                       wizard frontend hides the form, but
//                                       we still gate at the API).
//
// Auth: client session via resolveClientFromSession (NextAuth magic-link or
// dev fallback).
// =============================================================================

interface PatchBody {
  data?: unknown;
  status?: unknown;
}

function errorResponse(error: string, status: number, detail?: string) {
  return NextResponse.json(
    detail ? { error, detail } : { error },
    { status },
  );
}

/**
 * Fetch the cliente's tier in the same round trip we need for the step
 * read. Returns null when the cliente row is missing (the auth helper
 * would have already 401'd, so this is a defense-in-depth).
 */
async function loadClientTier(
  clientId: string,
): Promise<{ tier: WizardTier | null; rawTier: string }> {
  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: { tier: true },
  });
  return {
    tier: normalizeTier(client?.tier ?? null),
    rawTier: client?.tier ?? 'starter',
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { step: string } },
) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return errorResponse('service_unavailable', 503, 'DATABASE_URL is not set');
  }

  let stepNumber: WizardStepNumber;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    return errorResponse('bad_request', 400, 'step must be a string from the allowlist');
  }

  try {
    // BE-2: legacy read for latest + active rows (kept for the operator
    // review UI; the wizard shell reads the new tier-aware list endpoint).
    // BE-4: additionally fetch the cliente's tier so we can compute
    // `effectivePayload` and `autoConfigured`.
    const [result, tierCtx, latestRow] = await Promise.all([
      readWizardStep(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE, params.step),
      loadClientTier(resolved.clientId),
      readLatestStepForClient(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE, params.step),
    ]);

    if (!result) {
      // No saved row yet. We still want to return a well-formed BE-4
      // response so the cliente can see the default for hidden steps.
      const def = getStepDefinition(stepNumber);
      const visibleForTier = def.visibleFor(tierCtx.tier);
      const savedPayload = jsonToObject(latestRow?.payload ?? null);
      const resolvedStep = resolveClientStep(
        stepNumber,
        tierCtx.tier,
        {
          hasSavedVersion: latestRow !== null,
          status: latestRow?.latest?.status,
          submittedAt: latestRow?.latest?.submittedAt?.toISOString() ?? null,
          approvedAt: latestRow?.latest?.approvedAt?.toISOString() ?? null,
          activeForBot: latestRow?.latest?.activeForBot,
        },
        savedPayload,
      );
      return NextResponse.json({
        stepKey: params.step,
        clientId: resolved.clientId,
        tier: tierCtx.tier,
        number: def.number,
        label: def.label,
        block: def.block,
        visibleForTier,
        autoConfigured: resolvedStep.autoConfigured,
        v11Deferred: def.v11Deferred,
        latest: null,
        active: null,
        effectivePayload: resolvedStep.effectivePayload,
        savedPayload: resolvedStep.savedPayload,
        defaultPayload: resolvedStep.defaultPayload,
      });
    }

    const def = getStepDefinition(stepNumber);
    const visibleForTier = def.visibleFor(tierCtx.tier);
    // Prefer the latest row's payload (covers the BE-2 case where the
    // cliente has saved but not yet activated). `result.latest` is the
    // newest version regardless of activeForBot.
    const latestPayload = jsonToObject(
      (result.latest?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
    );
    const activePayload = jsonToObject(
      (result.active?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
    );
    const savedPayload = latestPayload ?? activePayload;

    const resolvedStep = resolveClientStep(
      stepNumber,
      tierCtx.tier,
      {
        hasSavedVersion: !!result.latest,
        status: result.latest?.status,
        submittedAt: result.latest?.submittedAt?.toISOString() ?? null,
        approvedAt: result.latest?.approvedAt?.toISOString() ?? null,
        activeForBot: result.latest?.activeForBot,
      },
      savedPayload,
    );

    return NextResponse.json({
      stepKey: params.step,
      clientId: resolved.clientId,
      tier: tierCtx.tier,
      number: def.number,
      label: def.label,
      block: def.block,
      visibleForTier,
      autoConfigured: resolvedStep.autoConfigured,
      v11Deferred: def.v11Deferred,
      latest: result.latest
        ? {
            id: result.latest.id,
            version: result.latest.version,
            status: result.latest.status,
            payload: result.latest.payload,
            submittedAt: result.latest.submittedAt?.toISOString() ?? null,
            approvedAt: result.latest.approvedAt?.toISOString() ?? null,
            activeForBot: result.latest.activeForBot,
            createdAt: result.latest.createdAt.toISOString(),
            updatedAt: result.latest.updatedAt.toISOString(),
          }
        : null,
      active: result.active
        ? {
            id: result.active.id,
            version: result.active.version,
            status: result.active.status,
            payload: result.active.payload,
            submittedAt: result.active.submittedAt?.toISOString() ?? null,
            approvedAt: result.active.approvedAt?.toISOString() ?? null,
            createdAt: result.active.createdAt.toISOString(),
            updatedAt: result.active.updatedAt.toISOString(),
          }
        : null,
      effectivePayload: resolvedStep.effectivePayload,
      savedPayload: resolvedStep.savedPayload,
      defaultPayload: resolvedStep.defaultPayload,
    });
  } catch (err) {
    if (err instanceof WizardClientError && err.error.code === 'invalid_step_key') {
      return errorResponse('bad_request', 400, 'step must be a string from the allowlist');
    }
    console.error('[GET /api/portal/wizard/[step]]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { step: string } },
) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return errorResponse('service_unavailable', 503, 'DATABASE_URL is not set');
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return errorResponse('bad_request', 400, 'body must be valid JSON');
  }

  if (typeof body.status !== 'string' || (body.status !== 'draft' && body.status !== 'submitted')) {
    return errorResponse('bad_request', 400, 'status must be "draft" or "submitted"');
  }
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return errorResponse('bad_request', 400, 'data must be a JSON object');
  }

  // BE-4 gate: a cliente whose tier hides the step cannot save to it.
  // Step 12 is hidden for every tier (v1.1 deferred) and is rejected
  // here as a defense-in-depth — the wizard frontend also hides the
  // form, but the API must agree.
  let stepNumber: WizardStepNumber;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    return errorResponse('bad_request', 400, 'step must be a string from the allowlist');
  }
  const tierCtx = await loadClientTier(resolved.clientId);
  const def = getStepDefinition(stepNumber);
  if (!def.visibleFor(tierCtx.tier)) {
    return errorResponse(
      'forbidden',
      403,
      'step is hidden for your tier; this step is auto-configured by the server',
    );
  }

  try {
    const result = await saveWizardStep(
      prisma,
      { clientId: resolved.clientId, email: resolved.email, productCode: CHATBOT_PRODUCT_CODE },
      {
        stepKey: params.step,
        data: body.data as Record<string, unknown>,
        status: body.status as WizardStepStatus,
      },
    );
    return NextResponse.json({
      stepId: result.stepId,
      stepKey: params.step,
      version: result.version,
      status: result.status,
    });
  } catch (err) {
    if (err instanceof WizardClientError) {
      switch (err.error.code) {
        case 'invalid_step_key':
          return errorResponse('bad_request', 400, 'step must be a string from the allowlist');
        case 'invalid_status':
          return errorResponse('bad_request', 400, 'status must be "draft" or "submitted"');
        case 'invalid_data':
          return errorResponse('bad_request', 400, 'data must be a JSON object');
      }
    }
    console.error('[PATCH /api/portal/wizard/[step]]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
