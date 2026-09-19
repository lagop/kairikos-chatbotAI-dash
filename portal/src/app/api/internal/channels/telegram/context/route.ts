import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { buildChatbotContext } from '@/lib/chatbot-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/telegram/context
//
// Mirror of /api/internal/channels/web/context (Fase 4), keyed by
// connectionId (the URL path segment n8n's "Kairikos Telegram
// Multi-tenant" workflow reads from its own webhook path
// kairikos-telegram/:connectionId) instead of a publicToken — Telegram
// doesn't have an equivalent to the widget's public identifier, the
// per-connection webhook URL itself is what disambiguates the client.
// =============================================================================

const BodySchema = z.object({ connectionId: z.string().trim().min(1) });

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', detail: 'connectionId is required' }, { status: 400 });
  }

  const connection = await prisma.telegramConnection.findUnique({ where: { id: body.data.connectionId } });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  // Fase 1.1 — los cuatro campos de siempre más `config`, la
  // configuración completa del wizard. Ver lib/chatbot-config.ts.
  // Fase 4 multi-instancia — contesta el chatbot al que sirve ESTE canal (el
  // ancla de la fase 1). Ver resolveChatbotForChannel y
  // ReplyToIncomingMessageInput.instance.
  const instance = await resolveChatbotForChannel(prisma, connection.clientId, connection.clientProductId);
  const context = await buildChatbotContext(prisma, connection.clientId, instance);

  return NextResponse.json({
    ok: true,
    clientId: connection.clientId,
    ...context,
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
