import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant, createWebQuoteInvoice, syncInvoiceFromStripe } from '@/lib/stripe-billing';
import { resolveDepositPlan } from '@/lib/web-quotes';
import { sendWebQuoteInvoiceEmail } from '@/lib/web-quote-email';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/generate-invoice
 *
 * The operator's explicit confirmation after the client accepted —
 * per the confirmed design, acceptance does NOT auto-invoice. Requires
 * a fresh TOTP step-up (creates a real Stripe billing object).
 *
 * WebQuote v2 — bifurcates on depositCents: without a deposit this
 * invoices the full amount (role='full', status→'invoiced') exactly as
 * before; with a deposit it invoices only that amount (role='deposit',
 * status→'invoiced_deposit') and .../generate-final-invoice handles the
 * remaining balance once the deposit is paid.
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

  const plan = resolveDepositPlan(webQuote);
  const role: 'full' | 'deposit' = plan.hasDeposit ? 'deposit' : 'full';
  const invoiceAmountCents = plan.hasDeposit ? plan.depositCents! : webQuote.amountCents;
  const nextStatus = plan.hasDeposit ? 'invoiced_deposit' : 'invoiced';

  try {
    const invoice = await createWebQuoteInvoice({
      stripeCustomerId,
      amountCents: invoiceAmountCents,
      currency: webQuote.currency,
      description: plan.hasDeposit ? `${webQuote.description} — adelanto` : webQuote.description,
      metadata: {
        kairikos_tenant_id: clientProduct.tenantId,
        kairikos_client_id: webQuote.clientId,
        kairikos_client_product_id: clientProduct.id,
        kairikos_web_quote_id: webQuote.id,
        kairikos_product_code: 'web',
        kairikos_invoice_role: role,
      },
    });
    // Persist the Invoice mirror synchronously (same pattern as the admin
    // billing checkout route) so the operator UI has hostInvoiceUrl right
    // away, instead of waiting for the invoice.created webhook to land.
    await syncInvoiceFromStripe(invoice);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.webQuote.update({ where: { id: webQuote.id }, data: { status: nextStatus } });
      await tx.webQuoteAudit.create({
        data: {
          webQuoteId: row.id,
          action: nextStatus,
          before: { status: 'accepted' },
          after: { status: nextStatus, stripeInvoiceId: invoice.id },
          actorOperatorId: stepUp.operatorId,
        },
      });
      return row;
    });

    const localInvoice = await prisma.invoice.findUnique({ where: { stripeId: invoice.id ?? '' } });

    // Best-effort — an email failure never blocks the invoice actually
    // being created, which already happened above.
    const client = await prisma.chatbotClient.findUnique({
      where: { id: updated.clientId },
      select: { email: true, companyName: true, name: true },
    });
    if (client) {
      const emailResult = await sendWebQuoteInvoiceEmail({
        to: client.email,
        businessName: client.companyName ?? client.name,
        amountCents: invoiceAmountCents,
        currency: updated.currency,
        role,
        hostInvoiceUrl: localInvoice?.hostInvoiceUrl ?? null,
      });
      if (!emailResult.ok) {
        logError('web_quote_email.invoice_failed', new Error(emailResult.error), {
          route: 'POST web-quotes/[id]/generate-invoice',
          webQuoteId: updated.id,
        });
      }
    }

    return NextResponse.json({ ok: true, webQuote: updated, invoice: localInvoice });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST web-quotes/[id]/generate-invoice] stripe call failed:', err);
    return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
  }
}
