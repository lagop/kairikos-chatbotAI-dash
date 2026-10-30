import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { saveDraftContent } from '@/lib/web-draft-editor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 30/10/2026 — PATCH /api/admin/portal/prospecting/web-draft/[leadId]/content
//
// El operador guarda el borrador de un prospecto desde el editor de webs
// (SiteContentEditor, modo borrador). La lógica, el historial y la huella
// están en web-draft-editor.ts. El prospecto ve el cambio en cuanto se
// guarda: su enlace pinta siempre lo último.
// =============================================================================

export async function PATCH(req: NextRequest, props: { params: Promise<{ leadId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const result = await saveDraftContent(prisma, params.leadId, await req.json().catch(() => null), auth.operatorId);
  return NextResponse.json(result.body, { status: result.status });
}
