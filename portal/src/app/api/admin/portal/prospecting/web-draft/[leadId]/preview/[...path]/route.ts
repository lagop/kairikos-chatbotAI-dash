import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { serveDraftImage } from '@/lib/web-draft-images';
import { isUuid } from '@/lib/web-draft-edit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/prospecting/web-draft/[leadId]/preview/assets/subidas/<archivo>
 * — 31/10/2026
 *
 * La miniatura que enseña el editor en cuanto se sube una foto, antes de
 * guardar (el editor las pide a `${apiBase}/preview/<ruta>`, como en una web).
 * Solo fotos subidas al borrador: la vista en vivo es el POST de …/preview.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ leadId: string; path: string[] }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!isUuid(params.leadId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return serveDraftImage(prisma, { kind: 'prospecting', where: { leadId: params.leadId } }, params.path.join('/'));
}
