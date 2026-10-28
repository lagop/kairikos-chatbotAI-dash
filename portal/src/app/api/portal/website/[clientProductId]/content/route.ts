import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { saveWebsiteContent } from '@/lib/website-content-save';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — PATCH /api/portal/website/[id]/content
//
// El cliente guarda el contenido v2 de su web (site-content.ts): textos,
// secciones en orden y ocultas, bloques libres, datos legales y qué secciones
// con datos de ejemplo ha confirmado. Sigue la regla del editor de siempre:
// cambia CONTENIDO, nunca la plantilla, que es del operador.
//
// El guardado vive en website-content-save.ts desde el 28/10/2026: el
// operador edita con el mismo editor (…/admin/portal/websites/[id]/content)
// y tiene que guardar exactamente igual.
// =============================================================================

export async function PATCH(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // El clientId sale de la sesión y se cruza con el de la URL.
  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
    select: { id: true, clientId: true, tenantId: true, content: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await saveWebsiteContent(prisma, website, await req.json().catch(() => null), { type: 'client', clientId: resolved.clientId });
  return NextResponse.json(result.body, { status: result.status });
}
