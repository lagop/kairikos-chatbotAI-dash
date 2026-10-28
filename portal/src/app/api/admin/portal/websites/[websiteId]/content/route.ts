import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { saveWebsiteContent } from '@/lib/website-content-save';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 28/10/2026 — PATCH /api/admin/portal/websites/[websiteId]/content
//
// El operador guarda el contenido v2 de la web de un cliente con el mismo
// editor que el cliente (SiteContentEditor) y el mismo guardado
// (website-content-save.ts); solo cambia quién firma en la auditoría. Guardar
// no publica, igual que para el cliente.
// =============================================================================

export async function PATCH(req: NextRequest, props: { params: Promise<{ websiteId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const website = await prisma.clientWebsite.findUnique({
    where: { id: params.websiteId },
    select: { id: true, clientId: true, tenantId: true, content: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

  const result = await saveWebsiteContent(prisma, website, await req.json().catch(() => null), {
    type: 'operator',
    operatorId: auth.operatorId,
    email: operator?.email ?? null,
  });
  return NextResponse.json(result.body, { status: result.status });
}
