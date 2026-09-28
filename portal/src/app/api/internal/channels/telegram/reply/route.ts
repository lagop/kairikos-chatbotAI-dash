import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { telegramConnectionIdSchema } from '@/lib/telegram-connection-id';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { replyToIncomingMessage } from '@/lib/chatbot-conversation';
import { decryptChannelCredential } from '@/lib/channel-crypto';
import { telegramWebhookSecretMatches } from '@/lib/telegram-api';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 1.2 — POST /api/internal/channels/telegram/reply
//
// Hermana de .../whatsapp/reply: genera la respuesta del bot para un
// mensaje entrante y guarda ambos turnos. Ver el comentario de aquella
// ruta y lib/chatbot-conversation.ts para el diseño completo.
//
// El clientId se resuelve desde la conexión de Telegram, nunca del cuerpo.
//
// Revisión de seguridad del 22/09/2026 — `webhookSecret` es la cabecera
// X-Telegram-Bot-Api-Secret-Token de la entrega original, reenviada por n8n.
// Sin ella, cualquiera que conociera el connectionId de la URL del webhook
// podía inyectar mensajes. Ver telegramWebhookSecret en lib/telegram-api.ts.
// Una conexión creada antes de esto no tiene el secreto registrado en
// Telegram: hay que reconectar el bot (desconectar y conectar) una vez.
// =============================================================================

const BodySchema = z.object({
  connectionId: telegramConnectionIdSchema,
  chatId: z.union([z.string(), z.number()]),
  text: z.string().trim().min(1).max(4000),
  webhookSecret: z.string().max(256).optional(),
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

  const connection = await prisma.telegramConnection.findUnique({ where: { id: body.data.connectionId } });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const botToken = decryptChannelCredential({
    ciphertext: connection.botTokenCiphertext,
    iv: connection.botTokenIv,
    tag: connection.botTokenTag,
  });
  if (!telegramWebhookSecretMatches(botToken, body.data.webhookSecret)) {
    logError('channels.telegram_reply.bad_webhook_secret', new Error('webhook_secret_mismatch'), {
      connectionId: connection.id,
      hadSecret: Boolean(body.data.webhookSecret),
    }, 'warn');
    return NextResponse.json({ error: 'invalid_webhook_secret' }, { status: 401 });
  }

  // Fase 4 multi-instancia — contesta el chatbot al que sirve ESTE canal (el
  // ancla de la fase 1). Ver resolveChatbotForChannel y
  // ReplyToIncomingMessageInput.instance.
  const instance = await resolveChatbotForChannel(prisma, connection.clientId, connection.clientProductId);
  const result = await replyToIncomingMessage(prisma, {
    clientId: connection.clientId,
    instance,
    tenantId: connection.tenantId,
    channel: 'telegram',
    key: { kind: 'inactivity', sessionPrefix: `telegram-${body.data.chatId}-` },
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
    // El tope del mes, igual que el traspaso: 200 con reply nulo. NO 503,
    // porque un 503 invita a reintentar y el tope seguirá agotado; el turno
    // del cliente ya quedó guardado. Ver lib/chatbot-usage.ts.
    if (result.reason === 'monthly_cap_reached') {
      return NextResponse.json({
        ok: true,
        conversationId: result.conversationId,
        reply: null,
        reason: 'monthly_cap_reached',
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
