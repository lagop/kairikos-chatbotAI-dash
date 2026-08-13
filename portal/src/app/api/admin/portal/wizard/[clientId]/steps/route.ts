import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { listStepsForOperator, buildSavedStateMap } from '@/lib/wizard-visibility';
import {
  readLatestStepsForClient,
  resolveClientTier,
} from '@/lib/wizard-tier-prisma';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';

// =============================================================================
// KAIA-1166 (BE-4) — Operator-facing tier-agnostic wizard step list.
//
//   GET /api/admin/portal/wizard/[clientId]/steps
//
// Always returns the full 12-step catalog. The operator's view ignores
// the cliente's tier; Step 12 is rendered with `v11Deferred: true` so
// the frontend can show the "Próximamente" label without hiding the row.
//
// Auth: operator session cookie OR legacy `x-kaia-operator-key` header.
// =============================================================================

const CLIENT_ID_RE = /^[a-z0-9_-]{1,64}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: { clientId: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const { clientId } = params;
  if (!CLIENT_ID_RE.test(clientId)) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'clientId must match [a-z0-9_-]{1,64}' },
      { status: 400 },
    );
  }

  const client = await resolveClientTier(prisma, clientId);
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const savedRows = await readLatestStepsForClient(prisma, clientId, CHATBOT_PRODUCT_CODE);
  const savedMap = buildSavedStateMap(
    savedRows.map((r) => ({
      stepKey: r.stepKey,
      latest: r.latest
        ? {
            status: r.latest.status,
            submittedAt: r.latest.submittedAt?.toISOString() ?? null,
            approvedAt: r.latest.approvedAt?.toISOString() ?? null,
            activeForBot: r.latest.activeForBot,
          }
        : null,
    })),
  );

  const response = listStepsForOperator(clientId, client.tier, savedMap);
  return NextResponse.json(response);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
