import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { MOCK_FLOW_HEALTH_ROWS, getFlowHealthRows } from '@/lib/flow-health';

// GET /api/admin/portal/flows
// Returns per-client flow health for the operator dashboard (KAIA-1060 / KAIA-1072).
// Auth: operator session OR x-kaia-operator-key header matching KAIA_OPERATOR_API_KEY
// (both paths handled by authenticateAdminRequest).

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(MOCK_FLOW_HEALTH_ROWS);
  }

  try {
    const rows = await getFlowHealthRows(prisma);
    return NextResponse.json(rows);
  } catch (err) {
    console.error('[GET /api/admin/portal/flows]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
