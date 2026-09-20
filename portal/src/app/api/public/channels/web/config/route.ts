import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { buildChatbotContext } from '@/lib/chatbot-config';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — GET /api/public/channels/web/config?token=wgt_...
//
// The ONLY route the widget bundle (public/widget/embed.js) calls on
// the portal directly — everything else (chat traffic itself) goes
// straight to n8n, per the plan's "el widget NO pasa por el portal para
// el tráfico de mensajes" design. Genuinely public/unauthenticated: it
// runs in an anonymous visitor's browser on a THIRD-PARTY site, so it
// can carry no shared secret. publicToken is the only credential and is
// deliberately non-sensitive by design (same posture as an analytics
// write key) — this route only ever returns display copy plus the
// (non-secret) n8n webchat endpoint URL, never anything from
// /api/internal/*.
//
// CORS: Access-Control-Allow-Origin: * — the whole point of this route
// is to be called cross-origin from whatever domain a client pastes the
// snippet into, which is unknown ahead of time.
// =============================================================================

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Abierta a internet y con CORS: la llama el navegador de cada visitante.
 *  Es de lectura, así que el límite es holgado — está para frenar un bucle,
 *  no a un visitante con varias pestañas. Se cuenta por token de widget y no
 *  por IP: detrás de una IP puede haber una oficina entera mirando la misma
 *  web. */
const tokenRateLimiter = new InMemoryRateLimiter(60 * 1000);
const CONFIG_MAX_POR_MINUTO = 120;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400, headers: CORS_HEADERS });
  }
  if (!tokenRateLimiter.check(`widget-config:${token}`, CONFIG_MAX_POR_MINUTO)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: CORS_HEADERS });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503, headers: CORS_HEADERS });
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken: token } });
  if (!embed || embed.status !== 'active') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  }

  // Fase 4 multi-instancia — lo que el widget enseña (nombre del negocio,
  // bienvenida, despedida, sugerencias) es de SU chatbot. Esta ruta lo
  // calculaba a mano, leyendo el paso 9 por cliente: con dos chatbots, el
  // widget de un negocio habría saludado con el mensaje del otro y con el
  // nombre de la empresa. buildChatbotContext ya hace exactamente esto, por
  // chatbot, para el motor de respuesta; aquí se usa la misma función en vez
  // de mantener una copia que se separe.
  const instance = await resolveChatbotForChannel(prisma, embed.clientId, embed.clientProductId);
  const context = await buildChatbotContext(prisma, embed.clientId, instance);

  return NextResponse.json(
    {
      businessName: context.businessName,
      welcomeMessage: context.welcomeMessage,
      farewellMessage: context.farewellMessage,
      suggestedPrompts: context.suggestedPrompts,
      primaryColor: embed.primaryColor,
      position: embed.position,
      chatEndpoint: process.env.N8N_WEBCHAT_URL ?? null,
    },
    { headers: CORS_HEADERS },
  );
}
