import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { replyToIncomingMessage } from '@/lib/chatbot-conversation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 1.2 — POST /api/internal/channels/messenger/reply
//
// Hermana de .../whatsapp/reply: genera la respuesta del bot para un
// mensaje entrante y guarda ambos turnos. Ver el comentario de aquella
// ruta y lib/chatbot-conversation.ts para el diseño completo.
//
// El clientId se resuelve desde el pageId de la conexión, nunca del cuerpo.
// =============================================================================

const BodySchema = z.object({
  pageId: z.string().trim().min(1),
  senderId: z.string().trim().min(1),
  text: z.string().trim().min(1).max(4000),
});

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'messenger', externalId: body.data.pageId },
  });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const result = await replyToIncomingMessage(prisma, {
    clientId: connection.clientId,
    tenantId: connection.tenantId,
    channel: 'messenger',
    key: { kind: 'inactivity', sessionPrefix: `messenger-${body.data.senderId}-` },
    message: body.data.text,
  });

  if ('skipped' in result) {
    // Fase 3 — un traspaso a humano NO es un fallo: una persona tiene la
    // conversación y va a contestar ella desde el portal. Se responde 200
    // con reply nulo para que quien llama no envíe nada y, sobre todo, para
    // que no lo reintente: un reintento contra un 503 volvería a mandar el
    // mismo mensaje del cliente.
    if (result.reason === 'human_handoff') {
      return NextResponse.json({
        ok: true,
        conversationId: result.conversationId,
        reply: null,
        handledBy: 'human',
      });
    }
    // El turno del cliente sí quedó guardado; lo que falta es la clave de IA.
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'ai_not_configured', conversationId: result.conversationId },
      { status: 503 },
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: 'reply_failed', detail: result.error, conversationId: result.conversationId },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    conversationId: result.conversationId,
    reply: result.reply,
    escalate: result.escalate,
    escalateReason: result.escalateReason,
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
