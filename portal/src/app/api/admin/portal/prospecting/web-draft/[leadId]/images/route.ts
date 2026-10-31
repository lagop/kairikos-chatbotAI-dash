import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { uploadDraftImage } from '@/lib/web-draft-images';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/prospecting/web-draft/[leadId]/images — 31/10/2026
 *
 * El operador sube el logo o una foto al borrador de un prospecto desde el
 * editor (lib/web-draft-images.ts). Solo la guarda: el borrador pasa a usarla
 * cuando se guarda el contenido que la cita.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ leadId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const result = await uploadDraftImage(prisma, params.leadId, req);
  return NextResponse.json(result.body, { status: result.status });
}
