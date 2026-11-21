import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { resolveClientWebEmbed } from '@/lib/chat-web-embed';
import { parseAllowedOrigins, updateWidgetAllowedOrigins } from '@/lib/web-widget-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// PUT /api/admin/portal/clients/[id]/web-widget-origins?clientProductId=…
//
// La misma lista que el cliente edita en Portal → Canales → Web (las webs
// desde las que funciona su chat, PR #408), pero desde la ficha del cliente en
// el panel de operador (21/11/2026). Hasta hoy, cambiar la de otro —la demo de
// Alisio, o un cliente que pide «limitadlo a mi dominio» y no entra en su
// portal— era un SQL a mano en producción.
//
// Mismo lib que la ruta del cliente: misma normalización, mismo tope, misma
// transacción con su fila en chat_web_embed_audit. Lo único distinto es el
// actor: `operator`, con el id y el email del operador de la sesión, para que
// el historial distinga quién cambió la lista.
//
// El cliente sí viene en la URL: esto es admin y el operador puede actuar sobre
// cualquiera. Con varios chatbots hay que decir cuál (?clientProductId), igual
// que en el portal.
// =============================================================================

const BodySchema = z.object({
  allowedOrigins: z.array(z.string().max(300)).max(30),
});

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { id: clientId } = await props.params;

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const parsed = parseAllowedOrigins(body.data.allowedOrigins);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, value: parsed.value ?? null }, { status: 400 });
  }

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
