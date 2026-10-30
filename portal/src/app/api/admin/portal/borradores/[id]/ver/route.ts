import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { servePublicDraftReview } from '@/lib/public-draft-editor';
import { publicOrigin } from '@/lib/public-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 30/10/2026 — GET /api/admin/portal/borradores/[id]/ver
 *
 * El borrador que pidió un negocio en kairikos.com, tal como lo va a ver, para
 * revisarlo ANTES de enviárselo: su propio enlace (/mi-web) dice «lo estamos
 * preparando» hasta entonces (lib/public-draft-delivery.ts).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  return servePublicDraftReview(prisma, params.id, publicOrigin(req));
}
