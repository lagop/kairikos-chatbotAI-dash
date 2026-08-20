import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { step9Schema } from '@/lib/wizard-schemas';

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

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400, headers: CORS_HEADERS });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503, headers: CORS_HEADERS });
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken: token } });
  if (!embed || embed.status !== 'active') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: embed.clientId },
    select: { companyName: true, name: true },
  });

  const step9 = await prisma.chatbotConfigStep.findFirst({
    where: { clientId: embed.clientId, productCode: CHATBOT_PRODUCT_CODE, stepKey: '9', activeForBot: true },
    select: { payload: true },
  });
  const parsedStep9 = step9Schema.safeParse(step9?.payload ?? {});

  return NextResponse.json(
    {
      businessName: client?.companyName ?? client?.name ?? 'Nosotros',
      welcomeMessage: parsedStep9.success ? parsedStep9.data.mensaje_bienvenida : '¡Hola! ¿En qué puedo ayudarte?',
      farewellMessage: parsedStep9.success ? (parsedStep9.data.mensaje_despedida ?? null) : null,
      suggestedPrompts: parsedStep9.success ? parsedStep9.data.prompts_sugeridos : [],
      primaryColor: embed.primaryColor,
      position: embed.position,
      chatEndpoint: process.env.N8N_WEBCHAT_URL ?? null,
    },
    { headers: CORS_HEADERS },
  );
}
