import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { resolveClientWebEmbed } from '@/lib/chat-web-embed';
import { parseAllowedOrigins, updateWidgetAllowedOrigins } from '@/lib/web-widget-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// PUT /api/admin/portal/clients/[id]/web-origins?clientProductId=…
//
// 21/11/2026 — el operador edita las webs desde las que funciona el widget del
// chat de un cliente. Es la misma lista que el cliente edita en Portal →
// Canales → Web (PUT /api/portal/channels/web/origins), con la misma
// validación y el mismo guardado (lib/web-widget-origin.ts); solo cambia quién
// firma la fila de auditoría: el operador, con su id y su email.
//
// Hace falta para los clientes que no entran en su portal (las demos, o un
// cliente al que se le monta todo) y para poder cerrar un widget que alguien
// está usando desde otra web sin esperar al cliente.
// =============================================================================

const BodySchema = z.object({
  // Antes de normalizar: el tope real (10) se aplica después de quitar
  // repetidos y líneas vacías.
  allowedOrigins: z.array(z.string().max(300)).max(30),
});

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const parsed = parseAllowedOrigins(body.data.allowedOrigins);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, value: parsed.value ?? null }, { status: 400 });
  }

  const { id: clientId } = await props.params;
  const found = await resolveClientWebEmbed(prisma, clientId, req.nextUrl.searchParams.get('clientProductId'));
  if (!found.ok && found.reason === 'ambiguous') {
    return NextResponse.json({ error: 'chatbot_not_specified' }, { status: 409 });
  }
  if (!found.ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  const result = await updateWidgetAllowedOrigins(prisma, found.embed, parsed.origins, {
    type: 'operator',
    operatorId: auth.operatorId,
    email: operator?.email ?? `operator:${auth.operatorId}`,
  });
  return NextResponse.json({ ok: true, allowedOrigins: result.allowedOrigins, changed: result.changed });
}
