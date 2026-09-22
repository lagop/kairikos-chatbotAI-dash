import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { connectRecallWhatsappManually } from '@/lib/recall-meta';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/[subscriptionId]/meta-manual — el operador
// conecta a mano el WhatsApp de una suscripción de recall (ver
// connectRecallWhatsappManually en lib/recall-meta.ts).
//
// Exige TOTP: guarda un token de Meta con el que se envían mensajes en
// nombre de un negocio. El token nunca se devuelve ni se registra.
// =============================================================================

const BodySchema = z.object({
  wabaId: z.string().trim().regex(/^\d{5,25}$/),
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/),
  accessToken: z.string().trim().min(20).max(2000),
});

const ERROR_STATUS: Record<string, number> = {
  subscription_not_found: 404,
  invalid_status: 409,
  token_not_verifiable: 502,
  token_invalid: 400,
  short_lived_token: 400,
  missing_permissions: 400,
  waba_not_accessible: 400,
  phone_not_in_waba: 400,
  phone_number_not_found: 400,
  persist_failed: 500,
};

export async function POST(req: NextRequest, { params }: { params: { subscriptionId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  if (!/^[0-9a-f-]{36}$/i.test(params.subscriptionId)) {
    return NextResponse.json({ error: 'subscription_not_found' }, { status: 404 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    // Sin details: el cuerpo lleva un token y no se devuelve nada de él.
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });

  try {
    const result = await connectRecallWhatsappManually(prisma, {
      subscriptionId: params.subscriptionId,
      wabaId: body.data.wabaId,
      phoneNumberId: body.data.phoneNumberId,
      accessToken: body.data.accessToken,
      operator: { operatorId: stepUp.operatorId, email: operator?.email ?? null },
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...('detail' in result && result.detail ? { detail: result.detail } : {}) },
        { status: ERROR_STATUS[result.error] ?? 400 },
      );
    }
    return NextResponse.json({
      ok: true,
      connectionId: result.connectionId,
      displayPhoneNumber: result.displayPhoneNumber,
      advancedTo: result.advancedTo,
    });
  } catch (err) {
    logError('recall_meta.manual_route_failed', err, { subscriptionId: params.subscriptionId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
