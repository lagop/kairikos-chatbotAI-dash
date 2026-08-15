import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { canSendWebQuote } from '@/lib/web-quotes';
import { sendWebQuoteSentEmail } from '@/lib/web-quote-email';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/send
 *
 * The compromising step: the client will see this amount. Requires a
 * fresh TOTP step-up — same bar as the Stripe catalog settings screen.
 * Sends (or re-sends, after an edit) using whatever amount/description
 * is currently saved — it does not accept a body of its own.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (!canSendWebQuote(webQuote.status)) {
    return NextResponse.json({ error: 'quote_locked' }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'sent', sentAt: new Date(), sentByOperatorId: stepUp.operatorId },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'sent',
        before: { status: webQuote.status },
        after: { status: 'sent', amountCents: row.amountCents },
        actorOperatorId: stepUp.operatorId,
      },
    });
    return row;
  });

  // Best-effort — an email failure never blocks the quote actually
  // being marked 'sent', which already happened above.
  const client = await prisma.chatbotClient.findUnique({
    where: { id: updated.clientId },
    select: { email: true, companyName: true, name: true },
  });
  if (client) {
    const result = await sendWebQuoteSentEmail({
      to: client.email,
      businessName: client.companyName ?? client.name,
      amountCents: updated.amountCents,
      currency: updated.currency,
      description: updated.description,
    });
    if (!result.ok) {
      logError('web_quote_email.sent_failed', new Error(result.error), { route: 'POST web-quotes/[id]/send', webQuoteId: updated.id });
    }
  }

  return NextResponse.json({ ok: true, webQuote: updated });
}
