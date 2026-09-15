import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sendApprovedCampaign } from '@/lib/recovery-campaigns';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 3 — GET /api/cron/recovery-tick
//
// LO QUE ESTE BARRIDO HACE: mandar las campañas que UNA PERSONA YA APROBÓ.
// LO QUE NO HACE, Y NO ES UN OLVIDO: crear campañas.
//
// Un cron que creara borradores solo, cada cinco minutos, acabaría
// llenando el panel de campañas que nadie mira — y el día que alguien
// apruebe una por inercia, habrá sido el cron quien decidió a quién se le
// escribe. Los borradores los crea una acción de operador; este barrido
// solo ejecuta lo ya decidido.
//
// La aprobación se vuelve a comprobar DENTRO de sendApprovedCampaign, no
// aquí: la consulta de abajo filtra por 'approved' por eficiencia, pero la
// garantía no puede depender de que un llamante recuerde filtrar.
//
// Idempotente y seguro de llamar de más, como exige scripts/scheduler.sh:
// los miembros ya enviados salen de 'pending' y no se vuelven a tocar.
// =============================================================================

/** Cuántas campañas por tick. Bajo a propósito: cada una puede mandar
 *  hasta 200 mensajes, y el scheduler tiene presupuesto de petición. */
const MAX_CAMPAIGNS_PER_TICK = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const campaigns = await prisma.recoveryCampaign.findMany({
    where: { status: 'approved' },
    orderBy: { approvedAt: 'asc' },
    take: MAX_CAMPAIGNS_PER_TICK,
    select: { id: true },
  });

  let sent = 0;
  let failed = 0;
  let excludedLate = 0;

  for (const campaign of campaigns) {
    // Por campaña, misma disciplina que el resto de barridos: una que
    // falle no puede abortar el tick para las demás.
    try {
      const result = await sendApprovedCampaign(prisma, campaign.id);
      sent += result.sent;
      failed += result.failed;
      excludedLate += result.excludedLate;
    } catch (err) {
      logError('cron.recovery_tick_failed', err, { campaignId: campaign.id }, 'warn');
    }
  }

  return NextResponse.json({ campaigns: campaigns.length, sent, failed, excludedLate });
}
