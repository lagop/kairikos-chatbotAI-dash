import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  getClientWizardStep,
  WizardTierServiceError,
} from '@/lib/wizard-tier-service';

// =============================================================================
// KAIA-1166 — Cliente wizard SINGLE-STEP view (BE-4).
//
//   GET /api/portal/wizard/step/[number]
//
// Returns the resolved single-step view for the authenticated cliente.
// Behaviour depends on the step's visibility for the cliente's tier:
//
//   visible (in catalog.visibleFor for the tier):
//     - 200 with effectivePayload = savedPayload ?? defaultPayload,
//       autoConfigured = (savedPayload === null), visible = true.
//
//   hidden (not in catalog.visibleFor for the tier):
//     - 200 with effectivePayload = defaultPayload,
//       autoConfigured = true, visible = false, savedPayload surfaced
//       for FE introspection. The cliente UI uses `visible: false` to
//       render the step as "managed by your plan" instead of a form.
//
//   out-of-range:
//     - 404 (step number is not 1..12).
//
// Auth: cliente session via resolveClientFromSession.
// =============================================================================

function errorResponse(error: string, status: number, detail?: string) {
  return NextResponse.json(
    detail ? { error, detail } : { error },
    { status },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { number: string } },
) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return errorResponse('service_unavailable', 503, 'DATABASE_URL is not set');
  }

  const parsed = Number.parseInt(params.number, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
    return errorResponse('not_found', 404, 'step number must be an integer 1..12');
  }

  try {
    const out = await getClientWizardStep(prisma, { clientId: resolved.clientId }, parsed);
    if (out.kind === 'not_found') {
      return errorResponse('not_found', 404, 'step number must be an integer 1..12');
    }
    return NextResponse.json(out.data);
  } catch (err) {
    if (err instanceof WizardTierServiceError) {
      if (err.error.code === 'client_not_found') {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
    }
    console.error('[GET /api/portal/wizard/step/[number]]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
