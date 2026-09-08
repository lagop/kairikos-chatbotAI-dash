import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { buildChatbotContext } from '@/lib/chatbot-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/messenger/context
//
// Mirror of .../whatsapp/context, keyed by pageId — Meta's Messenger
// webhook payload carries the recipient Page id on every event
// (entry[].id), which is exactly MetaChannelConnection.externalId for
// channel='messenger' rows.
// =============================================================================

const BodySchema = z.object({ pageId: z.string().trim().min(1) });

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', detail: 'pageId is required' }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'messenger', externalId: body.data.pageId },
  });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  // Fase 1.1 — los cuatro campos de siempre más `config`, la
  // configuración completa del wizard. Ver lib/chatbot-config.ts.
  const context = await buildChatbotContext(prisma, connection.clientId);

  return NextResponse.json({
    ok: true,
    clientId: connection.clientId,
    ...context,
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
