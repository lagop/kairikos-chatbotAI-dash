import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { canDiscard, canMarkContacted, canMarkConverted } from '@/lib/leads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ status: z.enum(['contactado', 'convertido', 'descartado']) });

const TIMESTAMP_FIELD: Record<'contactado' | 'convertido' | 'descartado', 'contactedAt' | 'convertedAt' | 'discardedAt'> = {
  contactado: 'contactedAt',
  convertido: 'convertedAt',
  descartado: 'discardedAt',
};

const AUDIT_ACTION: Record<'contactado' | 'convertido' | 'descartado', string> = {
  contactado: 'marked_contacted',
  convertido: 'marked_converted',
  descartado: 'marked_discarded',
};

/**
 * WP-XX — Leads Fase 4. Client-driven status transition
 * (nuevo -> contactado -> convertido, con descartado como salida
 * lateral). Mismo esqueleto que
 * /api/portal/google-business/campaigns/[id]/route.ts: sesión ->
 * resolveClientFromSession -> zod -> ownership check (404, no 403, para
 * no revelar existencia) -> transición ilegal (409) -> $transaction
 * (update + LeadAudit).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const lead = await prisma.lead.findUnique({ where: { id: params.id } });
  if (!lead || lead.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const target = body.data.status;
  const legal =
    (target === 'contactado' && canMarkContacted(lead.status)) ||
    (target === 'convertido' && canMarkConverted(lead.status)) ||
    (target === 'descartado' && canDiscard(lead.status));
  if (!legal) {
    return NextResponse.json({ error: 'illegal_transition', detail: `${lead.status} -> ${target}` }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.update({
      where: { id: lead.id },
      data: { status: target, [TIMESTAMP_FIELD[target]]: new Date() },
    });
    await tx.leadAudit.create({
      data: {
        leadId: row.id,
        clientId: resolved.clientId,
        tenantId: lead.tenantId,
        action: AUDIT_ACTION[target],
        statusBefore: lead.status,
        statusAfter: target,
        actorId: `client:${resolved.clientId}`,
      },
    });
    return row;
  });

  return NextResponse.json({ id: updated.id, status: updated.status });
}
