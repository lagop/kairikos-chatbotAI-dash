import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { canCancelWebQuote } from '@/lib/web-quotes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/cancel
 *
 * Abandons a quote before it's invoiced. No TOTP — this never touches
 * Stripe (cancelling an already-invoiced quote is out of scope for v1;
 * that would need stripe.invoices.voidInvoice, handled manually in the
 * Stripe Dashboard for now). Does not touch ClientProduct.status — the
 * client stays in 'quote_pending' until the operator resets this same
 * WebQuote back to 'draft' (see .../reset) to try again.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (!canCancelWebQuote(webQuote.status)) {
    return NextResponse.json({ error: 'cannot_cancel' }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'cancelled',
        before: { status: webQuote.status },
        after: { status: 'cancelled' },
        actorOperatorId: auth.operatorId,
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, webQuote: updated });
}
