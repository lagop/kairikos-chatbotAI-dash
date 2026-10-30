import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { serveDraftPreview } from '@/lib/web-draft-editor';
import { parsePreviewOverride } from '@/lib/website-preview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/prospecting/web-draft/[leadId]/preview — 30/10/2026
 *
 * La vista EN VIVO del editor de borradores, con lo que hay escrito sin
 * guardar. No guarda nada. Para ver el borrador guardado, la ruta de siempre
 * (GET …/web-draft/[leadId]).
 */
export async function POST(req: NextRequest, props: { params: Promise<{ leadId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const override = parsePreviewOverride(await req.json().catch(() => null));
  if (!override) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  return serveDraftPreview(prisma, params.leadId, override);
}
