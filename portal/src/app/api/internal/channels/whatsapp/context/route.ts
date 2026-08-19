import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { step9Schema } from '@/lib/wizard-schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/whatsapp/context
//
// Mirror of .../telegram/context, keyed by phoneNumberId instead of a
// connectionId n8n has to be told about separately — WhatsApp's webhook
// payload already carries `metadata.phone_number_id` on every incoming
// message (that's how a single app-level webhook stays multi-tenant),
// so that's the natural lookup key. externalId on MetaChannelConnection
// IS the phone_number_id for channel='whatsapp' rows (see the
// complete-signup route).
// =============================================================================

const BodySchema = z.object({ phoneNumberId: z.string().trim().min(1) });

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', detail: 'phoneNumberId is required' }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'whatsapp', externalId: body.data.phoneNumberId },
  });
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
