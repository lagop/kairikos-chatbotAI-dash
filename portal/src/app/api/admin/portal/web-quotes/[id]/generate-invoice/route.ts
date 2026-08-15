import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant, createWebQuoteInvoice, syncInvoiceFromStripe } from '@/lib/stripe-billing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/generate-invoice
 *
 * The operator's explicit confirmation after the client accepted —
 * per the confirmed design, acceptance does NOT auto-invoice. Requires
 * a fresh TOTP step-up (creates a real Stripe billing object).
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
  if (webQuote.status !== 'accepted') {
    return NextResponse.json({ error: 'not_accepted' }, { status: 409 });
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

  try {
    const invoice = await createWebQuoteInvoice({
      stripeCustomerId,
      amountCents: webQuote.amountCents,
      currency: webQuote.currency,
      description: webQuote.description,
      metadata: {
        kairikos_tenant_id: clientProduct.tenantId,
        kairikos_client_id: webQuote.clientId,
        kairikos_client_product_id: clientProduct.id,
        kairikos_web_quote_id: webQuote.id,
        kairikos_product_code: 'web',
      },
    });
    // Persist the Invoice mirror synchronously (same pattern as the admin
    // billing checkout route) so the operator UI has hostInvoiceUrl right
    // away, instead of waiting for the invoice.created webhook to land.
    await syncInvoiceFromStripe(invoice);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.webQuote.update({ where: { id: webQuote.id }, data: { status: 'invoiced' } });
      await tx.webQuoteAudit.create({
        data: {
          webQuoteId: row.id,
          action: 'invoiced',
          before: { status: 'accepted' },
          after: { status: 'invoiced', stripeInvoiceId: invoice.id },
          actorOperatorId: stepUp.operatorId,
        },
      });
      return row;
    });

    const localInvoice = await prisma.invoice.findUnique({ where: { stripeId: invoice.id ?? '' } });
    return NextResponse.json({ ok: true, webQuote: updated, invoice: localInvoice });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST web-quotes/[id]/generate-invoice] stripe call failed:', err);
    return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
  }
}
