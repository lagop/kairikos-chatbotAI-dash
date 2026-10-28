import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { uploadWebsiteImage } from '@/lib/site-uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 28/10/2026 — POST /api/portal/website/[id]/images
//
// El cliente sube su logo o una foto (multipart, campo «archivo»). Devuelve
// la ruta dentro de su web; el editor la pone en el contenido y se guarda con
// el PATCH de siempre (…/content). Subir no cambia la web: hasta que no
// guarda, la imagen no la cita nada. Ver site-uploads.ts.
//
// El clientId sale de la sesión y se cruza con el de la URL.
// =============================================================================

export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
    select: { id: true, clientId: true, tenantId: true, content: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await uploadWebsiteImage(prisma, website, req, { type: 'client', clientId: resolved.clientId });
  return NextResponse.json(result.body, { status: result.status });
}
