import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { step9Schema } from '@/lib/wizard-schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — POST /api/internal/channels/web/context
//
// Called by the n8n "Kairikos Webchat Multi-tenant" workflow on every
// inbound widget message, BEFORE building the system prompt — this is
// what makes that workflow multi-tenant instead of one clone per client
// (see the WhatsApp "Reusable Template" precedent this deliberately does
// NOT follow). Resolves the widget's publicToken to the business copy
// n8n needs: which client, what to call the business, and the
// welcome/farewell/suggested-prompts copy already captured (and
// operator-approved) in the wizard's Paso 9 — read from the row with
// activeForBot=true, never a draft, so an in-progress edit never leaks
// into a live conversation.
//
// Same auth as every other /api/internal/* route: shared secret via
// PORTAL_API_KEY (authenticateInternalRequest), fail closed if unset.
// =============================================================================

const BodySchema = z.object({ publicToken: z.string().trim().min(1) });

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', detail: 'publicToken is required' }, { status: 400 });
  }

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken: body.data.publicToken } });
  if (!embed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (embed.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
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

  return NextResponse.json({
    ok: true,
    clientId: embed.clientId,
    businessName: client?.companyName ?? client?.name ?? 'nuestro negocio',
    welcomeMessage: parsedStep9.success ? parsedStep9.data.mensaje_bienvenida : '¡Hola! ¿En qué puedo ayudarte?',
    farewellMessage: parsedStep9.success ? (parsedStep9.data.mensaje_despedida ?? null) : null,
    suggestedPrompts: parsedStep9.success ? parsedStep9.data.prompts_sugeridos : [],
    primaryColor: embed.primaryColor,
    position: embed.position,
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
