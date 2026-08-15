import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant, createWebQuoteInvoice, syncInvoiceFromStripe } from '@/lib/stripe-billing';
import { resolveDepositPlan } from '@/lib/web-quotes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/generate-final-invoice
 *
 * WebQuote v2 — the second half of a two-part payment. Only valid once
 * the deposit has been confirmed paid (status==='deposit_paid'). Invoices
 * the remaining balance (amountCents - depositCents), role='final', so
 * that paying it (online or manually) activates the ClientProduct — see
 * activateClientProductFromWebQuotePayment's role branching. Requires a
 * fresh TOTP step-up, same standard as generate-invoice.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (webQuote.status !== 'deposit_paid') {
    return NextResponse.json({ error: 'not_deposit_paid' }, { status: 409 });
  }

  const clientProduct = await prisma.clientProduct.findUnique({
    where: { id: webQuote.clientProductId },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct || !clientProduct.tenantId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'client_has_no_tenant' }, { status: 503 });
  }

  const stripeCustomerId = await ensureCustomerForTenant(clientProduct.tenantId);
  if (!stripeCustomerId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_customer_create_failed' }, { status: 503 });
  }

  const plan = resolveDepositPlan(webQuote);

  try {
    const invoice = await createWebQuoteInvoice({
      stripeCustomerId,
      amountCents: plan.finalCents,
      currency: webQuote.currency,
      description: `${webQuote.description} — saldo final`,
      metadata: {
        kairikos_tenant_id: clientProduct.tenantId,
        kairikos_client_id: webQuote.clientId,
        kairikos_client_product_id: clientProduct.id,
        kairikos_web_quote_id: webQuote.id,
        kairikos_product_code: 'web',
        kairikos_invoice_role: 'final',
      },
    });
    await syncInvoiceFromStripe(invoice);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.webQuote.update({ where: { id: webQuote.id }, data: { status: 'invoiced_final' } });
      await tx.webQuoteAudit.create({
        data: {
          webQuoteId: row.id,
          action: 'invoiced_final',
          before: { status: 'deposit_paid' },
          after: { status: 'invoiced_final', stripeInvoiceId: invoice.id },
          actorOperatorId: stepUp.operatorId,
        },
      });
      return row;
    });

    const localInvoice = await prisma.invoice.findUnique({ where: { stripeId: invoice.id ?? '' } });
    return NextResponse.json({ ok: true, webQuote: updated, invoice: localInvoice });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST web-quotes/[id]/generate-final-invoice] stripe call failed:', err);
    return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
  }
}
