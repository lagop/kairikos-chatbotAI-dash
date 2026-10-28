import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { uploadWebsiteImage } from '@/lib/site-uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 28/10/2026 — POST /api/admin/portal/websites/[websiteId]/images
//
// El operador sube el logo o una foto a la web de un cliente, con el mismo
// editor y la misma función que el cliente (site-uploads.ts). Para cuando el
// cliente manda sus fotos por WhatsApp o por correo en vez de subirlas él.
// =============================================================================

export async function POST(req: NextRequest, props: { params: Promise<{ websiteId: string }> }) {
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

  const result = await uploadWebsiteImage(prisma, website, req, { type: 'operator', operatorId: auth.operatorId, email: operator?.email ?? null });
  return NextResponse.json(result.body, { status: result.status });
}
