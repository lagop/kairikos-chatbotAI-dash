import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { draftCampaign } from '@/lib/recovery-campaigns';
import { loadRecallSubscription } from '@/lib/recall-recovery-admin';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/[subscriptionId]/recovery/drafts
//
// Crea el BORRADOR de una campaña: evalúa el disparador y congela la lista.
// No envía nada ni aprueba nada — la campaña nace en 'draft' siempre, y el
// cron solo recoge las aprobadas. Es exactamente la "acción de operador"
// que el diseño de la Fase 3 daba por hecha y que faltaba.
//
// No exige un operador identificable, a diferencia de aprobar: crear un
// borrador no tiene consecuencias fuera del panel. Lo que las tiene es
// aprobarlo, y esa ruta sí lo exige.
// =============================================================================

const BodySchema = z.object({
  trigger: z.enum(['open_quote', 'service_anniversary', 'dormant']),
});

interface Params {
  params: { subscriptionId: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const subscription = await loadRecallSubscription(prisma, params.subscriptionId);
  if (!subscription) return NextResponse.json({ error: 'subscription_not_found' }, { status: 404 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  try {
    const result = await draftCampaign(prisma, {
      clientId: subscription.clientId,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      trigger: body.data.trigger,
    });
    if (!result) {
      // Sin nadie a quien escribir no se crea nada: un borrador vacío es
      // ruido para quien tiene que aprobar.
      return NextResponse.json({ ok: false, error: 'no_candidates' }, { status: 200 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logError('recall_recovery.draft_failed', err, { subscriptionId: subscription.id }, 'warn');
    return NextResponse.json({ error: 'draft_failed' }, { status: 500 });
  }
}
