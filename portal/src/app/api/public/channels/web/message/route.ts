import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { replyToIncomingMessage } from '@/lib/chatbot-conversation';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { isReservedSessionId } from '@/lib/conversation-session-id';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 2b — POST /api/public/channels/web/message
//
// El widget (public/widget/embed.js) hablaba con n8n para el tráfico de
// chat (Fase 2a: n8n solo traducía la respuesta al contrato del widget,
// ver automations/desplegado/webchat-multi-tenant.json → "Format
// Response"). Esta ruta hace lo mismo que ese nodo, pero en el portal:
// llama a replyToIncomingMessage directamente, sin pasar por n8n ni por
// PORTAL_API_URL/PORTAL_API_KEY. n8n sale del camino del widget.
//
// embed.js NO cambia: sigue mandando { action, publicToken, sessionId,
// message, timestamp } y leyendo json.data.reply. Lo único que cambia es
// que /api/public/channels/web/config le da esta URL como chatEndpoint
// en vez de N8N_WEBCHAT_URL — ver ese archivo.
//
// Genuinely public/unauthenticated, igual que .../web/config: corre en el
// navegador de un visitante anónimo en la web de un cliente. publicToken
// es el único "credential" y es no-secreto a propósito.
//
// La clasificación de leads del widget YA NO se dispara desde aquí: n8n
// tenía su propio clasificador en caliente por canal (Telegram, WhatsApp,
// Messenger, Instagram, Web — los cinco duplicaban la misma llamada a
// OpenAI). Se retiraron todos en favor del barrido único del portal
// (classify-leads-sweep.ts, que conoce el perfil de cualificación del
// cliente y ya cubre cualquier canal sin código específico) — ver
// docs/plan-motor-chatbot.md, sección "Dos clasificadores de leads".
// =============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// sessionId lo elige el navegador: no puede tener la forma del de otro canal
// (ver conversation-session-id.ts — era la puerta a las conversaciones de
// WhatsApp de los clientes del negocio).
const BodySchema = z.object({
  publicToken: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(200).refine((id) => !isReservedSessionId(id)),
  message: z.string().trim().min(1).max(4000),
});

// Este endpoint SÍ gasta — cada llamada válida golpea el motor de IA. El
// de .../web/config es de solo lectura y aguanta 120/min; este necesita
// un freno más estricto, contado por publicToken igual que aquel (una
// oficina entera puede compartir IP).
const chatRateLimiter = new InMemoryRateLimiter(60 * 1000);
const CHAT_MAX_POR_MINUTO = 20;

const CONTACT_INTENT_RE =
  /(cita|presupuesto|contacto|llamar|llamame|reuni[oó]n|hablar|contratar|me interesa|quiero|necesito|reservar|agendar|disponibilidad|horario|email|correo|tel[eé]fono|whatsapp)/i;

function widgetPayload(data: {
  sessionId: string | null;
  reply: string;
  mode: string;
  contactIntent: boolean;
  error?: string | null;
}) {
  return {
    success: true,
    data: {
      sessionId: data.sessionId,
      reply: data.reply,
      timestamp: new Date().toISOString(),
      mode: data.mode,
      contactIntent: data.contactIntent,
      error: data.error ?? null,
    },
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { success: false, data: { sessionId: null, reply: null, mode: 'unavailable', error: 'bad_request' } },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { publicToken, sessionId, message } = body.data;

  if (!chatRateLimiter.check(`widget-chat:${publicToken}`, CHAT_MAX_POR_MINUTO)) {
    return NextResponse.json(
      { success: false, data: { sessionId, reply: null, mode: 'unavailable', error: 'too_many_requests' } },
      { status: 429, headers: CORS_HEADERS },
    );
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      { success: false, data: { sessionId, reply: null, mode: 'unavailable', error: 'service_unavailable' } },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken } });
  const contactIntent = CONTACT_INTENT_RE.test(message);

  if (!embed || embed.status !== 'active') {
    // Mismo texto y forma que el "Respond (widget not available)" de
    // n8n — el widget no distingue token inválido de widget apagado, y
    // no debe: no hay nada útil que un visitante pueda hacer con esa
    // información.
    return NextResponse.json(
      {
        success: false,
        data: {
          sessionId,
          reply: 'Este chat no está disponible en este momento.',
          timestamp: new Date().toISOString(),
          mode: 'unavailable',
          contactIntent: false,
          error: 'context_lookup_failed',
        },
      },
      { headers: CORS_HEADERS },
    );
  }

  const instance = await resolveChatbotForChannel(prisma, embed.clientId, embed.clientProductId);
  const result = await replyToIncomingMessage(prisma, {
    clientId: embed.clientId,
    instance,
    tenantId: embed.tenantId,
    channel: 'web',
    key: { kind: 'exact', externalSessionId: sessionId },
    message,
  });

  if ('skipped' in result) {
    if (result.reason === 'human_handoff') {
      return NextResponse.json(
        widgetPayload({
          sessionId,
          reply: 'Ahora mismo te atiende una persona del equipo. Escribe aquí tu mensaje y lo verá enseguida.',
          mode: 'human',
          contactIntent,
        }),
        { headers: CORS_HEADERS },
      );
    }
    if (result.reason === 'monthly_cap_reached') {
      return NextResponse.json(
        widgetPayload({
          sessionId,
          reply: 'Ahora mismo no puedo responderte por aquí. Déjanos tu consulta con un email o teléfono y el equipo te contesta en breve.',
          mode: 'cap',
          contactIntent,
        }),
        { headers: CORS_HEADERS },
      );
    }
    // Sin clave de IA configurada — el turno del cliente ya quedó
    // guardado. Mismo texto de reserva que usa n8n hoy para cualquier
    // fallo silencioso.
    return NextResponse.json(
      widgetPayload({
        sessionId,
        reply: contactIntent
          ? 'Gracias por escribir. Para ayudarte mejor, cuéntame tu nombre y un email o teléfono de contacto y el equipo te responderá en breve.'
          : 'Gracias por tu mensaje. Ahora mismo no puedo darte una respuesta detallada, pero el equipo lo revisará. Si quieres, déjame tus datos de contacto.',
        mode: 'fallback',
        contactIntent,
        error: 'ai_not_configured',
      }),
      { headers: CORS_HEADERS },
    );
  }

  if (!result.ok) {
    return NextResponse.json(
      widgetPayload({
        sessionId,
        reply: contactIntent
          ? 'Gracias por escribir. Para ayudarte mejor, cuéntame tu nombre y un email o teléfono de contacto y el equipo te responderá en breve.'
          : 'Gracias por tu mensaje. Ahora mismo no puedo darte una respuesta detallada, pero el equipo lo revisará. Si quieres, déjame tus datos de contacto.',
        mode: 'fallback',
        contactIntent,
        error: result.error,
      }),
      { headers: CORS_HEADERS },
    );
  }

  return NextResponse.json(
    widgetPayload({ sessionId, reply: result.reply, mode: 'portal', contactIntent }),
    { headers: CORS_HEADERS },
  );
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: CORS_HEADERS });
}
