import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { buildChatbotContext } from '@/lib/chatbot-config';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { isReservedSessionId } from '@/lib/conversation-session-id';
import { sendWidgetContactEmail } from '@/lib/handoff-alert-email';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/public/channels/web/contact — el visitante deja por dónde
// localizarle (22/09/2026).
//
// Por qué: en el chat de la web el bot decía "te paso con alguien del
// equipo" y eso NO podía cumplirse — por ahí no se puede contestar, la
// pestaña del visitante ya se cerró (ver chatbot-handoff.ts). La única
// forma de que la frase sea verdad es que la persona deje un teléfono o
// un correo, así que el widget lo pide justo cuando el bot deriva.
//
// Pública y sin autenticar como sus dos hermanas de esta carpeta: corre
// en el navegador de un desconocido, en la web de un cliente.
//
// El dato se guarda como un turno MÁS del visitante en el transcript, no
// en una columna nueva: es literalmente algo que escribió él, sale en la
// conversación del portal sin tocar esa pantalla, y evita una migración
// para un campo que además querría cifrado propio. Como queda en el
// historial, el bot tampoco vuelve a pedirlo en el siguiente turno.
//
// No crea un Lead: eso lo hace el barrido de clasificación cuando la
// conversación se cierra (classify-leads-sweep.ts), y solo si el cliente
// tiene Captación. Este endpoint no se mete en ese camino.
// =============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Un contacto útil trae una arroba o un puñado de dígitos. No se valida
// más: un teléfono internacional mal formateado sigue sirviendo para
// llamar, y rechazarlo perdería la única pista que hay.
function looksLikeContact(value: string): boolean {
  if (value.includes('@') && value.length >= 5) return true;
  return (value.match(/\d/g) ?? []).length >= 6;
}

const BodySchema = z.object({
  publicToken: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(200).refine((id) => !isReservedSessionId(id)),
  name: z.string().trim().max(80).optional(),
  contact: z.string().trim().min(3).max(120).refine(looksLikeContact),
});

// Más estricto que el del chat: dejar el contacto es algo que se hace una
// vez, y repetirlo cien veces solo sirve para llenar el transcript y la
// bandeja de entrada del negocio.
const contactRateLimiter = new InMemoryRateLimiter(60 * 1000);
const MAX_POR_MINUTO = 5;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'bad_request' }, { status: 400, headers: CORS_HEADERS });
  }
  const { publicToken, sessionId, contact } = body.data;
  const visitorName = body.data.name?.trim() ? body.data.name.trim() : null;

  if (!contactRateLimiter.check(`widget-contact:${publicToken}`, MAX_POR_MINUTO)) {
    return NextResponse.json({ success: false, error: 'too_many_requests' }, { status: 429, headers: CORS_HEADERS });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ success: false, error: 'service_unavailable' }, { status: 503, headers: CORS_HEADERS });
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken } });
  if (!embed || embed.status !== 'active') {
    // Mismo silencio que .../web/message: un desconocido no distingue
    // token inválido de widget apagado, y no debe.
    return NextResponse.json({ success: false, error: 'not_available' }, { status: 404, headers: CORS_HEADERS });
  }

  // La conversación se busca por el par (cliente, sesión), que es único.
  // El sessionId lo elige el navegador, pero el clientId sale del token:
  // nadie puede escribir en la conversación de otro negocio.
  const conversation = await prisma.chatbotConversation.findUnique({
    where: { clientId_externalSessionId: { clientId: embed.clientId, externalSessionId: sessionId } },
    select: { id: true, transcript: true, clientProductId: true },
  });
  if (!conversation) {
    return NextResponse.json({ success: false, error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  }

  const priorTranscript = Array.isArray(conversation.transcript) ? [...(conversation.transcript as unknown[])] : [];
  const entry = {
    role: 'user',
    content: visitorName
      ? `Mis datos de contacto: ${visitorName} — ${contact}`
      : `Mis datos de contacto: ${contact}`,
    at: new Date().toISOString(),
  };

  await prisma.chatbotConversation.update({
    where: { id: conversation.id },
    data: { transcript: [...priorTranscript, entry] as never },
  });

  // El aviso, después de guardar y sin poder tumbar la respuesta: si el
  // email falla, el dato ya está en la conversación.
  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: embed.clientId },
      select: { email: true },
    });
    if (client?.email) {
      const instance = await resolveChatbotForChannel(prisma, embed.clientId, embed.clientProductId);
      const context = await buildChatbotContext(prisma, embed.clientId, instance);
      const lastVisitorMessage = readLastVisitorMessage(priorTranscript);
      const result = await sendWidgetContactEmail({
        to: client.email,
        businessName: context.businessName,
        conversationId: conversation.id,
        visitorName,
        contact,
        lastMessage: lastVisitorMessage,
      });
      if (!result.ok) {
        logError('widget_contact.email_failed', new Error(result.error), { conversationId: conversation.id }, 'warn');
      }
    }
  } catch (err) {
    logError('widget_contact.notify_failed', err, { conversationId: conversation.id }, 'warn');
  }

  return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
}

/** Lo último que preguntó el visitante, para que el email diga de qué va
 *  sin obligar a abrir el portal. Si el transcript viene raro, se devuelve
 *  una frase honesta en vez de inventar nada. */
function readLastVisitorMessage(transcript: unknown[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i];
    if (
      entry && typeof entry === 'object'
      && (entry as { role?: unknown }).role === 'user'
      && typeof (entry as { content?: unknown }).content === 'string'
    ) {
      return (entry as { content: string }).content;
    }
  }
  return '(sin mensaje previo)';
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: CORS_HEADERS });
}
