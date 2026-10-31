import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { listDraftVersions } from '@/lib/draft-versions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 31/10/2026 — GET: las versiones anteriores del borrador pedido en
// kairikos.com (lib/draft-versions.ts).
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  return NextResponse.json({ versiones: await listDraftVersions(prisma, { kind: 'public', id: params.id }) });
}
