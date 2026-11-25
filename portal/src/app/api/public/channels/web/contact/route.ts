import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isWidgetOriginAllowed } from '@/lib/web-widget-origin';
import { buildChatbotContext } from '@/lib/chatbot-config';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { isReservedSessionId } from '@/lib/conversation-session-id';
import { sendWidgetContactEmail } from '@/lib/handoff-alert-email';
import { logError } from '@/lib/observability';
import { isKnownWidgetContactNoticeVersion } from '@/lib/web-widget-context';

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
//
// Consentimiento (25/11/2026, plan del encargo del tratamiento, PR 3).
// embed.v2.js enseña ahora un aviso de primera capa y una casilla obligatoria
// con el enlace a la política de privacidad, y manda `consent: true` y
// `noticeVersion`. Aquí:
//   - versión conocida y consentimiento → se guardan fecha y versión en la
//     conversación (contact_consent_at, contact_notice_version);
//   - versión conocida SIN consentimiento → 400 `consent_required`: el widget
//     no deja enviar sin la casilla, así que eso es alguien saltándosela;
//   - versión desconocida → 400 `bad_request`, como cualquier otro campo mal;
//   - SIN versión → se acepta como siempre, con las columnas a NULL, y se
//     cuenta como `widget_contact.legacy_no_consent`. Son embed.js (v1,
//     congelado: no tiene casilla) y las pestañas que se abrieron con el v2
//     anterior a este cambio. Rechazarlos dejaría sin formulario a todas las
//     webs v1, y el log dice cuántos quedan.
// `privacyLinkShown: false` dice que el widget no tenía URL de la política
// (ni `data-privacy-url` ni paso 10): se guarda igual —el aviso de primera
// capa sí salió— y se registra `widget.privacy_url_missing` para que alguien
// lo arregle. El negocio lo ve también en Canales.
//
// De paso, el turno nuevo actualiza `duration`, como hacen el motor
// (chatbot-conversation.ts) y la bandeja de traspaso: sin eso, la última
// actividad de la conversación (startedAt + duration) no contaba este
// mensaje, y es la fecha que usará la retención del chat.
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
  // Sin versión: envío de v1 o de una pestaña antigua (ver la cabecera).
  noticeVersion: z.string().trim().max(40).refine(isKnownWidgetContactNoticeVersion).optional(),
  consent: z.boolean().optional(),
  privacyLinkShown: z.boolean().optional(),
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
  const { publicToken, sessionId, contact, noticeVersion } = body.data;
  const visitorName = body.data.name?.trim() ? body.data.name.trim() : null;
  // Antes de tocar la base de datos: es un fallo del envío, no del widget.
  if (noticeVersion && body.data.consent !== true) {
    return NextResponse.json({ success: false, error: 'consent_required' }, { status: 400, headers: CORS_HEADERS });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json({ success: false, error: 'service_unavailable' }, { status: 503, headers: CORS_HEADERS });
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken } });
  // Dominios permitidos (16/11/2026): desde una web que no está en la lista,
  // lo mismo que un widget apagado. Ver lib/web-widget-origin.ts.
  if (!embed || embed.status !== 'active' || !isWidgetOriginAllowed(embed.allowedOrigins, req.headers)) {
    // Mismo silencio que .../web/message: un desconocido no distingue
    // token inválido de widget apagado, y no debe.
    return NextResponse.json({ success: false, error: 'not_available' }, { status: 404, headers: CORS_HEADERS });
  }
  // El cupo del widget se cuenta DESPUÉS de comprobar la web (21/11/2026):
  // con 5 por minuto, una web fuera de la lista lo agotaba enseguida y dejaba
  // sin formulario de contacto a las webs buenas. Ver .../web/config.
  if (!contactRateLimiter.check(`widget-contact:${publicToken}`, MAX_POR_MINUTO)) {
    return NextResponse.json({ success: false, error: 'too_many_requests' }, { status: 429, headers: CORS_HEADERS });
  }

  // La conversación se busca por el par (cliente, sesión), que es único.
  // El sessionId lo elige el navegador, pero el clientId sale del token:
  // nadie puede escribir en la conversación de otro negocio.
  const conversation = await prisma.chatbotConversation.findUnique({
    where: { clientId_externalSessionId: { clientId: embed.clientId, externalSessionId: sessionId } },
    select: { id: true, transcript: true, clientProductId: true, startedAt: true },
  });
  if (!conversation) {
    return NextResponse.json({ success: false, error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  }

  const now = new Date();
  const priorTranscript = Array.isArray(conversation.transcript) ? [...(conversation.transcript as unknown[])] : [];
  const entry = {
    role: 'user',
    content: visitorName
      ? `Mis datos de contacto: ${visitorName} — ${contact}`
      : `Mis datos de contacto: ${contact}`,
    at: now.toISOString(),
  };

  await prisma.chatbotConversation.update({
    where: { id: conversation.id },
    data: {
      transcript: [...priorTranscript, entry] as never,
      duration: Math.max(0, Math.round((now.getTime() - conversation.startedAt.getTime()) / 1000)),
      // Sin versión (v1 o pestaña antigua) las columnas no se tocan: quedan a
      // NULL, y si un envío anterior de la misma conversación sí consintió,
      // esa prueba no se borra.
      ...(noticeVersion ? { contactConsentAt: now, contactNoticeVersion: noticeVersion } : {}),
    },
  });

  if (!noticeVersion) {
    logError(
      'widget_contact.legacy_no_consent',
      new Error('contact_without_notice_version'),
      { conversationId: conversation.id },
      'warn',
    );
  } else if (body.data.privacyLinkShown === false) {
    logError(
      'widget.privacy_url_missing',
      new Error('contact_form_without_privacy_link'),
      { conversationId: conversation.id, clientId: embed.clientId },
      'warn',
    );
  }

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
