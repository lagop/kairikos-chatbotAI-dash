import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  getClientWizardStepList,
  WizardTierServiceError,
} from '@/lib/wizard-tier-service';

// =============================================================================
// KAIA-1166 — Cliente wizard step LIST (BE-4).
//
//   GET /api/portal/wizard/steps
//
// Returns the list of steps the authenticated cliente can interact with,
// filtered by `ChatbotClient.tier`. Hidden steps (Step 3 + 7 for Starter;
// Step 12 for every tier) are NOT in the response.
//
// Auth: cliente session via resolveClientFromSession. Mirrors the
// /api/portal/wizard/[step] auth path so Playwright + the dev-mock
// fallback both work.
// =============================================================================

function errorResponse(error: string, status: number, detail?: string) {
  return NextResponse.json(
    detail ? { error, detail } : { error },
    { status },
  );
}

export async function GET() {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return errorResponse('service_unavailable', 503, 'DATABASE_URL is not set');
  }

  try {
    const data = await getClientWizardStepList(prisma, { clientId: resolved.clientId });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof WizardTierServiceError) {
      if (err.error.code === 'client_not_found') {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
    }
    console.error('[GET /api/portal/wizard/steps]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
