import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { listEnquiriesForPanel, setEnquiryStatus } from '@/lib/cartera/enquiries';
import { ENQUIRY_STATUSES } from '@/lib/cartera/enquiry-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET   /api/portal/cartera/contactos                 los contactos de la web (los 500 últimos)
 * PATCH /api/portal/cartera/contactos  { id, status }  marcar como atendido (o volver a nuevo)
 *
 * Cartera — la pestaña Contactos. Sin borrar desde el panel: se borran solos a
 * los 24 meses (cron cartera-tick) y en la purga de la baja. En la gracia de
 * una baja se leen pero no se marcan (403 'read_only').
 */
export async function GET() {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;
  return NextResponse.json({ enquiries: await listEnquiriesForPanel(prisma, ctx.site.id), readOnly: ctx.readOnly });
}

const PatchSchema = z.object({ id: z.string().uuid(), status: z.enum(ENQUIRY_STATUSES) }).strict();

export async function PATCH(req: NextRequest) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const r = await setEnquiryStatus(prisma, ctx.site, body.data.id, body.data.status, ctx.actor);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
  return NextResponse.json(r);
}
