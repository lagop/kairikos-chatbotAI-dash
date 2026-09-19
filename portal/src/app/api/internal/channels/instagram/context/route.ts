import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveChatbotForChannel } from '@/lib/client-product-access';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { buildChatbotContext } from '@/lib/chatbot-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/instagram/context
//
// Mirror of .../messenger/context, keyed by igUserId — Meta's Instagram
// messaging webhook payload carries the recipient IG account id on
// every event (entry[].id, when object='instagram'), which is exactly
// MetaChannelConnection.externalId for channel='instagram' rows.
// =============================================================================

const BodySchema = z.object({ igUserId: z.string().trim().min(1) });

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', detail: 'igUserId is required' }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'instagram', externalId: body.data.igUserId },
  });
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
