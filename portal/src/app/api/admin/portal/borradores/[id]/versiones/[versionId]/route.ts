import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { restoreDraftVersion } from '@/lib/draft-versions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 31/10/2026 — POST: el borrador pedido en kairikos.com vuelve a esta versión;
// lo de ahora queda en el historial (lib/draft-versions.ts).
export async function POST(req: NextRequest, props: { params: Promise<{ id: string; versionId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const result = await restoreDraftVersion(prisma, { kind: 'public', id: params.id }, params.versionId, auth.operatorId);
  return NextResponse.json(result.body, { status: result.status });
}
