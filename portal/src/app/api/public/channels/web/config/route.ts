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
// Genuinely public/unauthenticated: it runs in an anonymous visitor's
// browser on a THIRD-PARTY site, so it can carry no shared secret.
// publicToken is the only credential and is deliberately non-sensitive
// by design (same posture as an analytics write key).
//
// CORS: Access-Control-Allow-Origin: * — the whole point of this route
// is to be called cross-origin from whatever domain a client pastes the
// snippet into, which is unknown ahead of time.
//
// Fase 2b — chatEndpoint used to be N8N_WEBCHAT_URL: the widget's chat
// traffic went straight to n8n, bypassing the portal entirely (n8n only
// translated the response). It now points back at this same origin's own
// /api/public/channels/web/message, which calls replyToIncomingMessage
// directly — no n8n, no PORTAL_API_URL/PORTAL_API_KEY in the loop for
// this channel anymore. embed.js didn't need to change: it already just
// POSTs to whatever chatEndpoint this route hands it.
// =============================================================================

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

/**
 * El origen PÚBLICO del portal, que no es el que ve el servidor.
 *
 * Esto se devolvía como `req.nextUrl.origin`, y en la VPS eso es
 * `https://0.0.0.0:3000` — la dirección con la que el contenedor escucha
 * detrás de Traefik, no una a la que pueda llamar el navegador de nadie.
 * Resultado: el widget cargaba, se pintaba, y cada mensaje del visitante
 * moría en su navegador. Visto el 22/09/2026 en la primera prueba real del
 * widget en producción.
 *
 * Mismo criterio que resolveWebhookUrl (telephony/twilio-signature.ts):
 * la variable configurada manda, y las cabeceras del proxy son el respaldo
 * para desarrollo local. Aquí el host reenviado no da ningún poder — lo
 * peor que consigue quien lo falsee es que su propio widget hable con su
 * propio servidor.
 */
function publicOrigin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_PORTAL_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

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
      chatEndpoint: `${publicOrigin(req)}/api/public/channels/web/message`,
    },
    { headers: CORS_HEADERS },
  );
}
