import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { approveCampaign, cancelCampaign } from '@/lib/recovery-campaigns';
import { resolveAttributableOperator } from '@/lib/recall-recovery-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/recovery/[campaignId]  { action }
//
// APROBAR es la decisión de escribir a clientes reales del profesional, así
// que exige un operador identificable: con la clave de API heredada no hay
// nadie a quien atribuirla, y `approvedByOperatorId` es precisamente el
// registro de quién fue. Se niega con 403 en vez de aprobar a nombre de
// nadie.
//
// CANCELAR no lo exige: parar un envío nunca le escribe a nadie, y bloquear
// una cancelación por un problema de atribución sería poner la barrera en
// el lado equivocado.
// =============================================================================

const BodySchema = z.object({ action: z.enum(['approve', 'cancel']) });

interface Params {
  params: { campaignId: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  if (body.data.action === 'cancel') {
    const result = await cancelCampaign(prisma, params.campaignId);
    if (result.ok) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: result.reason },
      { status: result.reason === 'not_found' ? 404 : 409 },
    );
  }

  const operator = await resolveAttributableOperator(prisma, auth.operatorId);
  if (!operator.ok) return NextResponse.json({ error: operator.reason }, { status: 403 });

  const result = await approveCampaign(prisma, params.campaignId, operator.operatorId);
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 409 });
}
