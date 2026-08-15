import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { markInvoicePaidManually } from '@/lib/stripe-billing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  channel: z.enum(['transfer', 'cash']),
  reference: z.string().min(1),
});

/**
 * POST /api/admin/portal/web-quotes/[id]/mark-paid
 *
 * Records an offline payment (bank transfer / cash). Requires a fresh
 * TOTP step-up. Delegates to markInvoicePaidManually, which calls
 * stripe.invoices.pay({paid_out_of_band:true}) — the resulting
 * invoice.paid webhook is what actually flips WebQuote/ClientProduct to
 * paid/active (see stripe-billing.ts), not this route directly, so the
 * UI may briefly still show 'invoiced' right after this returns 200.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (webQuote.status !== 'invoiced') {
    return NextResponse.json({ error: 'not_invoiced' }, { status: 409 });
  }

  const invoice = await prisma.invoice.findFirst({
    where: { clientProductId: webQuote.clientProductId },
    orderBy: { createdAt: 'desc' },
  });
  if (!invoice) return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });

  const result = await markInvoicePaidManually({
    invoiceId: invoice.id,
    channel: body.data.channel,
    reference: body.data.reference,
    markedByOperatorId: stepUp.operatorId,
  });
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

  return NextResponse.json({ ok: true });
}
