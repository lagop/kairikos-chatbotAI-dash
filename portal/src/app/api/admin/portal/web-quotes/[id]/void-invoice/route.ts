import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { voidWebQuoteInvoice } from '@/lib/stripe-billing';
import { canVoidInvoice } from '@/lib/web-quotes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/void-invoice
 *
 * WebQuote v2 — cancels a quote whose current invoice (full, deposit, or
 * final) hasn't been paid yet, by voiding it in Stripe. Requires a fresh
 * TOTP step-up (touches real Stripe billing state). Once a deposit or
 * the full amount has been paid there is no cancel path here — a refund
 * is a different, more sensitive operation and is out of scope; see
 * canVoidInvoice's comment. ClientProduct stays 'quote_pending' — the
 * operator can .../reset to try again with a new quote, same as the
 * existing no-Stripe cancel flow.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (!canVoidInvoice(webQuote.status)) {
    return NextResponse.json({ error: 'cannot_void' }, { status: 409 });
  }

  const invoice = await prisma.invoice.findFirst({
    where: { clientProductId: webQuote.clientProductId },
    orderBy: { createdAt: 'desc' },
  });
  if (!invoice) return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });

  const result = await voidWebQuoteInvoice({ invoiceId: invoice.id });
  if (!result.ok) {
    switch (result.error.kind) {
      case 'invoice_not_found':
        return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
      case 'already_paid':
        return NextResponse.json({ error: 'already_paid' }, { status: 409 });
      default:
        return NextResponse.json({ error: 'stripe_error', detail: result.error.detail }, { status: 502 });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'invoice_voided',
        before: { status: webQuote.status },
        after: { status: 'cancelled' },
        actorOperatorId: stepUp.operatorId,
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, webQuote: updated });
}
