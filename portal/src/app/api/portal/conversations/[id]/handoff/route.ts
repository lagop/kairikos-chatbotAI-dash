import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { sendAgentMessage, handoffState, isHandoffChannel } from '@/lib/chatbot-handoff';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 3 — POST /api/portal/conversations/[id]/handoff
//
// Las tres cosas que una persona hace con una conversación derivada:
// tomarla (el bot se calla), contestar (sale por el canal del cliente), y
// devolverla o cerrarla.
//
// Una sola ruta con una acción en el cuerpo, y no tres rutas: son
// transiciones de la MISMA cosa y separarlas obligaría a repetir en tres
// sitios la resolución de la conversación y su comprobación de propiedad —
// que es justo la comprobación que no puede fallar en ninguna de las tres.
// =============================================================================

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('take') }),
  z.object({ action: z.literal('reply'), text: z.string().trim().min(1).max(4000) }),
  z.object({ action: z.literal('close') }),
]);

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  // findFirst con el clientId dentro: un id de otra empresa no existe, en
  // vez de existir y estar prohibido.
  const conversation = await prisma.chatbotConversation.findFirst({
    where: { id: params.id, clientId: resolved.clientId },
    select: {
      id: true,
      channel: true,
      handoffRequestedAt: true,
      handoffTakenAt: true,
      handoffTakenBy: true,
      handoffClosedAt: true,
    },
  });
  if (!conversation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const agentEmail = session.email ?? `client:${resolved.clientId}`;
  const now = new Date();
  const state = handoffState(conversation);

  try {
    if (body.data.action === 'take') {
      if (state === 'taken') {
        // Ya la tiene alguien. Se dice quién, en vez de dejar que dos
        // personas contesten creyendo cada una que es la única.
        return NextResponse.json(
          { error: 'already_taken', takenBy: conversation.handoffTakenBy },
          { status: 409 },
        );
      }
      await prisma.chatbotConversation.update({
        where: { id: conversation.id },
        data: {
          // Tomar una conversación que nunca escaló también vale: el bot
          // puede estar respondiendo mal sin haberlo detectado, y esa es
          // una razón perfectamente buena para intervenir.
          handoffRequestedAt: conversation.handoffRequestedAt ?? now,
          handoffTakenAt: now,
          handoffTakenBy: agentEmail,
          handoffClosedAt: null,
        },
      });
      return NextResponse.json({ ok: true, state: 'taken', takenBy: agentEmail });
    }

    if (body.data.action === 'close') {
      await prisma.chatbotConversation.update({
        where: { id: conversation.id },
        data: { handoffClosedAt: now, handoffTakenAt: null, handoffTakenBy: null },
      });
      // Cerrada = devuelta al bot. handoffTakenAt vuelve a null porque es
      // lo que botShouldReply mira, y dejarlo puesto tendría al bot mudo
      // para siempre en esa conversación.
      return NextResponse.json({ ok: true, state: 'closed' });
    }

    // reply
    if (state !== 'taken') {
      // Contestar sin haberla tomado dejaría al bot respondiendo a la vez
      // que la persona, que es exactamente lo que esta bandeja evita.
      return NextResponse.json({ error: 'not_taken' }, { status: 409 });
    }
    if (!isHandoffChannel(conversation.channel)) {
      return NextResponse.json({ error: 'channel_not_supported' }, { status: 400 });
    }

    const result = await sendAgentMessage(prisma, {
      conversationId: conversation.id,
      clientId: resolved.clientId,
      text: body.data.text,
      agentEmail,
      now,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, detail: result.detail }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('portal.conversation_handoff.failed', err, { conversationId: params.id }, 'error');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
