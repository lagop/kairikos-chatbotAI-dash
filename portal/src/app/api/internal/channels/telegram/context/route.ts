import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { step9Schema } from '@/lib/wizard-schemas';

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

  const client = await prisma.chatbotClient.findUnique({
    where: { id: connection.clientId },
    select: { companyName: true, name: true },
  });

  const step9 = await prisma.chatbotConfigStep.findFirst({
    where: { clientId: connection.clientId, productCode: CHATBOT_PRODUCT_CODE, stepKey: '9', activeForBot: true },
    select: { payload: true },
  });
  const parsedStep9 = step9Schema.safeParse(step9?.payload ?? {});

  return NextResponse.json({
    ok: true,
    clientId: connection.clientId,
    businessName: client?.companyName ?? client?.name ?? 'nuestro negocio',
    welcomeMessage: parsedStep9.success ? parsedStep9.data.mensaje_bienvenida : '¡Hola! ¿En qué puedo ayudarte?',
    farewellMessage: parsedStep9.success ? (parsedStep9.data.mensaje_despedida ?? null) : null,
    suggestedPrompts: parsedStep9.success ? parsedStep9.data.prompts_sugeridos : [],
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
