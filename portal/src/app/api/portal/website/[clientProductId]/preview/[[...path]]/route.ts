import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { publicOrigin } from '@/lib/public-origin';
import { parsePreviewOverride, serveWebsitePreview } from '@/lib/website-preview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — GET /api/portal/website/[id]/preview/…
//
// El cliente ve su web ANTES de publicarla, tal y como saldría
// (website-preview.ts). Solo la del propio cliente: el clientId sale de la
// sesión y se cruza con el de la URL.
// =============================================================================

export async function GET(req: NextRequest, props: { params: Promise<{ clientProductId: string; path?: string[] }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return serveWebsitePreview(prisma, website, params.path, {
    mount: `/api/portal/website/${params.clientProductId}/preview/`,
    portalOrigin: publicOrigin(req),
  });
}

/**
 * POST — 29/10/2026: la vista previa EN VIVO del editor, con lo que hay en el
 * formulario sin guardar (website-preview.ts, override). Misma autorización
 * que GET (solo su propia web); no guarda nada.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string; path?: string[] }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const override = parsePreviewOverride(await req.json().catch(() => null));
  if (!override) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return serveWebsitePreview(prisma, website, params.path, {
    mount: `/api/portal/website/${params.clientProductId}/preview/`,
    portalOrigin: publicOrigin(req),
    override,
  });
}
