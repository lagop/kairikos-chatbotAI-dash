import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getOperatorWizardStepList,
  WizardTierServiceError,
} from '@/lib/wizard-tier-service';

// =============================================================================
// KAIA-1166 — Operator wizard step LIST (BE-4).
//
//   GET /api/admin/portal/wizard/[clientId]/steps
//
// Returns the full 12-step list for the operator review surface, with
// the cliente's tier surfaced for context. The operator view is
// tier-agnostic — Step 12 is always present even though no cliente can
// touch it in v1.
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
  { params }: { params: { clientId: string } },
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

  try {
    const data = await getOperatorWizardStepList(prisma, { clientId: params.clientId });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof WizardTierServiceError) {
      if (err.error.code === 'client_not_found') {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
    }
    console.error('[GET /api/admin/portal/wizard/[clientId]/steps]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
