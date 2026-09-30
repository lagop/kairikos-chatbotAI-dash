import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { registerLeadOptOut } from '@/lib/lead-opt-out';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Registrar que un prospecto no quiere que se le contacte, cuando lo pide
 * por teléfono o por correo (por WhatsApp ya lo registra solo
 * markProspectReplied). La lógica y el porqué, en src/lib/lead-opt-out.ts.
 *
 * Sin cuerpo: no hay nada que elegir. POST y no PATCH del estado porque no
 * es una transición más — toca también a los otros locales con el mismo
 * teléfono y no se deshace desde el portal.
 */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const result = await registerLeadOptOut(prisma, {
    clientId: resolved.clientId,
    leadId: params.id,
    actorId: `client:${resolved.clientId}`,
  });
  if (!result.ok) {
    return result.error === 'not_found'
      ? NextResponse.json({ error: 'not_found' }, { status: 404 })
      : NextResponse.json({ error: 'not_allowed', detail: 'ya_registrada_o_no_es_prospecto' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, leadIds: result.leadIds });
}
