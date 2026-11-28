import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { assignSiteToNewContract } from '@/lib/client-site';
import { ensureEventsToken, eventsEndpointUrl } from '@/lib/web-events';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web/[clientProductId]/results-tracking
 *   → { ok, endpoint, created }
 *
 * Informe mensual de resultados (28/11/2026). Activa la medición de la web:
 * da al sitio de esa web su token de eventos (wev_…) y devuelve la URL que
 * va en PUBLIC_EVENTS_ENDPOINT de la web Premium (docs/informe-mensual-web.md).
 *
 * Idempotente: si ya tiene token, devuelve el mismo. El token es público (va
 * en el HTML de la web), así que no hace falta enseñarlo una sola vez ni
 * pedir TOTP. Cambiarlo dejaría la web publicada contando al vacío, por eso
 * no hay botón para rotarlo: si alguna vez hace falta, a mano en la base de
 * datos y republicando la web.
 *
 * El id de la URL es el de la web ('web' activa); el sitio sale de ella.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const { clientProductId } = await props.params;
  if (!z.string().uuid().safeParse(clientProductId).success) {
    return NextResponse.json({ error: 'web_not_found' }, { status: 404 });
  }

  try {
    const web = await prisma.clientProduct.findFirst({
      where: { id: clientProductId, status: 'active', product: { code: 'web' } },
      select: { id: true, clientId: true, tenantId: true, clientSiteId: true },
    });
    if (!web) return NextResponse.json({ error: 'web_not_found' }, { status: 404 });

    // Una web antigua puede no tener sitio todavía: se le asigna, como hace
    // la oferta de mantenimiento (custom-care/route.ts).
    const clientSiteId =
      web.clientSiteId ??
      (
        await assignSiteToNewContract(prisma, {
          clientId: web.clientId,
          tenantId: web.tenantId,
          clientProductId: web.id,
          productCode: 'web',
        })
      ).clientSiteId;

    const r = await ensureEventsToken(prisma, clientSiteId);
    if (!r.ok) return NextResponse.json({ error: 'web_not_found' }, { status: 404 });
    return NextResponse.json(
      { ok: true, endpoint: eventsEndpointUrl(r.token), created: r.created },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    logError('web_events.admin_activate_failed', err, { clientProductId, operatorId: auth.operatorId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
