import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from './prisma';
import { getSession } from './session';
import { resolveClientFromSession } from './portal-session';
import { authenticateAdminRequest } from './operator-session';
import type { SettingsTarget } from './recall-owner-settings-http';

// =============================================================================
// Quién puede tocar el WhatsApp del dueño y la locución, y de qué alta.
//
// Cliente: su propia suscripción, resuelta SIEMPRE desde la sesión.
//
// Fase 3 multi-instancia — con varias líneas hace falta saber cuál, y ese
// dato sí viene de la petición. NO rompe la regla de aislamiento, porque no
// se usa como identificador sino como FILTRO sobre las suscripciones de este
// cliente: el id de otro no devuelve nada. Es el mismo patrón que
// resolveContractedInstance y que /portal/web/[clientProductId].
//
// Sin id se resuelve la única que haya; con varias se devuelve 409 en vez de
// elegir, porque guardar el WhatsApp del dueño en la línea equivocada manda
// los recados de un negocio al teléfono del otro.
//
// Operador: la suscripción de la URL, con sesión de operador real. La clave
// de API heredada no vale: el cambio queda atribuido en la auditoría.
// =============================================================================

export async function resolveClientTarget(clientProductId?: string | null): Promise<SettingsTarget | Response> {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const subs = await prisma.recallSubscription.findMany({
    where: {
      clientId: resolved.clientId,
      ...(clientProductId ? { clientProductId } : {}),
    },
    take: 2,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (subs.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (subs.length > 1) {
    return NextResponse.json({ error: 'line_not_specified' }, { status: 409 });
  }
  return { subscriptionId: subs[0].id, actor: { type: 'client', clientId: resolved.clientId } };
}

export async function resolveOperatorTarget(req: NextRequest, subscriptionId: string): Promise<SettingsTarget | Response> {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  return {
    subscriptionId,
    actor: { type: 'operator', operatorId: auth.operatorId, email: operator?.email ?? null },
  };
}
