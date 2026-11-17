import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { resolveClientWebEmbed } from '@/lib/chat-web-embed';
import { parseAllowedOrigins, updateWidgetAllowedOrigins } from '@/lib/web-widget-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// PUT /api/portal/channels/web/origins — las webs desde las que funciona el
// widget del chat (16/11/2026). Lista vacía = cualquiera, como hasta hoy.
//
// Ruta aparte del PATCH de apariencia (color, posición) a propósito: ese
// exige los dos campos y no deja rastro; esta deja auditoría
// (ChatWebEmbedAudit), porque decide desde dónde contesta el chat de un
// negocio. La validación y el guardado viven en lib/web-widget-origin.ts.
// =============================================================================

const BodySchema = z.object({
  // Antes de normalizar: el tope real (10) se aplica después de quitar
  // repetidos y líneas vacías.
  allowedOrigins: z.array(z.string().max(300)).max(30),
});

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = parseAllowedOrigins(body.data.allowedOrigins);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, value: parsed.value ?? null }, { status: 400 });
  }

  const found = await resolveClientWebEmbed(prisma, resolved.clientId, req.nextUrl.searchParams.get('clientProductId'));
  if (!found.ok && found.reason === 'ambiguous') {
    return NextResponse.json({ error: 'chatbot_not_specified' }, { status: 409 });
  }
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const result = await updateWidgetAllowedOrigins(prisma, found.embed, parsed.origins, {
    type: 'client',
    email: `client:${resolved.clientId}`,
  });
  return NextResponse.json({ ok: true, allowedOrigins: result.allowedOrigins, changed: result.changed });
}
