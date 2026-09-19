import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { replyToIncomingMessage } from '@/lib/chatbot-conversation';
import { markProspectReplied } from '@/lib/prospecting-replies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 1.2 — POST /api/internal/channels/whatsapp/reply
//
// Genera la respuesta del bot para un mensaje entrante y guarda ambos
// turnos. n8n queda como transporte: recibe el webhook de la plataforma,
// llama aquí, y entrega el `reply` por la API del canal.
//
// Distinta de .../message, que sigue existiendo para el caso en que quien
// llama ya tiene la respuesta y solo quiere registrarla.
//
// El clientId se resuelve desde el phone_number_id, nunca del cuerpo —
// misma razón que en el resto de rutas internas.
// =============================================================================

const BodySchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  from: z.string().trim().min(1),
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
    where: { channel: 'whatsapp', externalId: body.data.phoneNumberId },
  });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  // Fase 3.3 — antes de contestar: si este teléfono es un prospecto al que
  // la secuencia de prospección estaba escribiendo, se corta aquí. Va
  // primero a propósito, para que un fallo de la IA más abajo no deje al
  // prospecto recibiendo toques después de haber contestado.
  // markProspectReplied nunca lanza.
  await markProspectReplied(prisma, { clientId: connection.clientId, phone: body.data.from });

  // Fase 4 multi-instancia — contesta el chatbot al que sirve ESTE canal (el
  // ancla de la fase 1). Ver resolveChatbotForChannel y
  // ReplyToIncomingMessageInput.instance.
  const instance = await resolveChatbotForChannel(prisma, connection.clientId, connection.clientProductId);
  const result = await replyToIncomingMessage(prisma, {
    clientId: connection.clientId,
    instance,
    tenantId: connection.tenantId,
    channel: 'whatsapp',
    key: { kind: 'inactivity', sessionPrefix: `whatsapp-${body.data.from}-` },
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
