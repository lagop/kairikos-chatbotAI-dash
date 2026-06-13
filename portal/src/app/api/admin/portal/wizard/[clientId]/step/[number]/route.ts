import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getOperatorWizardStep,
  WizardTierServiceError,
} from '@/lib/wizard-tier-service';

// =============================================================================
// KAIA-1166 — Operator wizard SINGLE-STEP view (BE-4).
//
//   GET /api/admin/portal/wizard/[clientId]/step/[number]
//
// Returns both the cliente's saved payload and the catalog default so
// the operator can see what the cliente has on file vs. what the bot
// is actually running on. The operator view is tier-agnostic — every
// step 1..12 returns 200.
//
//   autoConfigured: true
//     The bot is running on defaults: cliente has no saved payload AND
//     the step is hidden for the cliente's tier. The operator UI uses
//     this to highlight the "managed by your plan" badge.
//
// Auth: operator session cookie OR legacy `x-kaia-operator-key` header.
// =============================================================================

function errorResponse(error: string, status: number, detail?: string) {
  return NextResponse.json(
    detail ? { error, detail } : { error },
    { status },
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: { clientId: string; number: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return errorResponse('service_unavailable', 503, 'DATABASE_URL is not set');
  }

  if (!params.clientId || typeof params.clientId !== 'string') {
    return errorResponse('bad_request', 400, 'clientId is required');
  }

  const parsed = Number.parseInt(params.number, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
    return errorResponse('not_found', 404, 'step number must be an integer 1..12');
  }

  try {
    const out = await getOperatorWizardStep(prisma, { clientId: params.clientId }, parsed);
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
    console.error('[GET /api/admin/portal/wizard/[clientId]/step/[number]]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
