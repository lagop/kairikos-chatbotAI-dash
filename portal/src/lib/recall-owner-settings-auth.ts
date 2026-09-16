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
// Cliente: su propia suscripción, resuelta SIEMPRE desde la sesión — nunca
// un id que venga en la petición (regla de aislamiento del repo).
// Operador: la suscripción de la URL, con sesión de operador real. La clave
// de API heredada no vale: el cambio queda atribuido en la auditoría.
// =============================================================================

export async function resolveClientTarget(): Promise<SettingsTarget | Response> {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const sub = await prisma.recallSubscription.findFirst({
    where: { clientId: resolved.clientId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!sub) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return { subscriptionId: sub.id, actor: { type: 'client', clientId: resolved.clientId } };
}

export async function resolveOperatorTarget(req: NextRequest, subscriptionId: string): Promise<SettingsTarget | Response> {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (auth.operatorId === 'legacy') {
    return NextResponse.json({ error: 'operator_session_required' }, { status: 403 });
  }
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  return {
    subscriptionId,
    actor: { type: 'operator', operatorId: auth.operatorId, email: operator?.email ?? null },
  };
}
