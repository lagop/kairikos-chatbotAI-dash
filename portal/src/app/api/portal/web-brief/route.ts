import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { WEB_ACCESSIBLE_STATUSES } from '@/lib/client-product-access';
import { webBriefSchema, webBriefDraftSchema } from '@/lib/web-brief-schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ClientProductIdSchema = z.object({ clientProductId: z.string().uuid() });

// This route used to gate on isProductContracted (status: 'active' only),
// which meant a client mid-quote (quote_pending, no payment yet) could
// OPEN the brief form (gated by canAccessWebProduct, which already
// allowed that status) but got a spurious 404 on save — the two checks
// had silently drifted apart. Fixed by sharing WEB_ACCESSIBLE_STATUSES
// with canAccessWebProduct instead of each guard keeping its own copy.

/**
 * POST /api/portal/web-brief
 *
 * Single upsert endpoint for the 'web' product's standalone intake form
 * (see prisma/schema.prisma's WebBrief model comment — deliberately not
 * built on the chatbot wizard engine), one per 'web' ClientProduct row
 * (project) — see that model's comment. `submit: true` validates against
 * the full schema (businessName/goal/pagesNeeded required) and stamps
 * `submittedAt`; `submit: false` saves whatever partial shape is valid
 * as a draft, no required fields. Resubmitting after 'submitted' is
 * allowed — this route never locks the row, the portal UI just chooses
 * whether to show the form or a summary based on `status`. Every write
 * also appends a WebBriefAudit row (before/after) so an operator can
 * reconstruct exactly what the brief said on any given date.
 *
 * 401 { error: 'unauthorized' }
 * 404 { error: 'not_found' } — clientProductId doesn't belong to this client, or isn't a 'web' row in an accessible status
 * 400 { error: 'invalid_body', details }
 * 503 { error: 'service_unavailable' }
 * 200 { status: 'draft' | 'submitted' }
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const rawBody = await req.json().catch(() => null);
  const idParsed = ClientProductIdSchema.safeParse(rawBody);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: idParsed.error.flatten() }, { status: 400 });
  }
  const { clientProductId } = idParsed.data;

  const clientProduct = await prisma.clientProduct.findUnique({
    where: { id: clientProductId },
    select: { id: true, clientId: true, tenantId: true, status: true, product: { select: { code: true } } },
  });
  if (
    !clientProduct ||
    clientProduct.clientId !== resolved.clientId ||
    clientProduct.product.code !== 'web' ||
    !WEB_ACCESSIBLE_STATUSES.includes(clientProduct.status)
  ) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const isSubmit = rawBody && typeof rawBody === 'object' && (rawBody as { submit?: unknown }).submit === true;
  const parsed = isSubmit ? webBriefSchema.safeParse(rawBody) : webBriefDraftSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }
  const { submit, ...fields } = parsed.data;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.webBrief.findUnique({ where: { clientProductId } });
    const row = await tx.webBrief.upsert({
      where: { clientProductId },
      create: {
        clientId: resolved.clientId,
        clientProductId,
        tenantId: clientProduct.tenantId,
        status: submit ? 'submitted' : 'draft',
        ...fields,
        submittedAt: submit ? now : null,
      },
      update: {
        status: submit ? 'submitted' : 'draft',
        ...fields,
        // A draft save never clears a previous submission's timestamp —
        // only a fresh `submit: true` (re)stamps it.
        ...(submit ? { submittedAt: now } : {}),
      },
    });
    await tx.webBriefAudit.create({
      data: {
        webBriefId: row.id,
        clientId: resolved.clientId,
        action: submit ? 'submitted' : 'draft_saved',
        before: existing ? JSON.parse(JSON.stringify(existing)) : null,
        after: JSON.parse(JSON.stringify(row)),
        actorType: 'client',
        actorEmail: `client:${resolved.clientId}`,
      },
    });
  });

  return NextResponse.json({ status: submit ? 'submitted' : 'draft' }, { status: 200 });
}
