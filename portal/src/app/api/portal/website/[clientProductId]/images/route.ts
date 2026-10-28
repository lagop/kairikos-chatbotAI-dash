import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { MAX_UPLOAD_BYTES, storeWebsiteImage } from '@/lib/site-uploads';

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
// El clientId sale de la sesión y se cruza con el de la URL. En la auditoría
// van la ruta y el tamaño, nunca la imagen.
// =============================================================================

const ERRORS: Record<string, number> = { too_large: 413, not_an_image: 415, too_big_dimensions: 422, too_many_images: 409 };

export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
    select: { id: true, tenantId: true, content: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (website.content == null) return NextResponse.json({ error: 'not_v2' }, { status: 409 });

  // Antes de leer el cuerpo entero: un archivo enorme se rechaza por su
  // cabecera sin cargarlo en memoria.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64_000) return NextResponse.json({ error: 'too_large' }, { status: 413 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('archivo');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const result = await storeWebsiteImage(prisma, website, Buffer.from(await file.arrayBuffer()));
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: ERRORS[result.error] ?? 400 });
    await prisma.clientWebsiteAudit.create({
      data: {
        websiteId: website.id,
        clientId: resolved.clientId,
        tenantId: website.tenantId,
        action: 'image_uploaded',
        after: { path: result.path, width: result.width, height: result.height, bytes: result.bytes },
        actorType: 'client',
        actorEmail: `client:${resolved.clientId}`,
      },
    });
    return NextResponse.json({ ok: true, path: result.path, width: result.width, height: result.height });
  } catch (err) {
    logError('client_website.image_upload_failed', err, { clientProductId: params.clientProductId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
