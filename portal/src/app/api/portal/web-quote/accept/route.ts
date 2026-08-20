import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { resolveWebQuoteContext } from '@/lib/web-quotes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/web-quote/accept
 *
 * The client's one-click acceptance of a sent quote. Does NOT create a
 * Stripe invoice — per the confirmed design, that's a separate,
 * operator-confirmed step (POST .../generate-invoice). No TOTP, this is
 * the client acting on their own quote.
 */
export async function POST() {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const context = await resolveWebQuoteContext(prisma, resolved.clientId);
  if (!context || !context.webQuote) {
    return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  }
  const { webQuote } = context;
  if (webQuote.status !== 'sent') {
    return NextResponse.json({ error: 'not_sent' }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'accepted',
        before: { status: 'sent' },
        after: { status: 'accepted' },
        actorType: 'client',
        actorEmail: `client:${resolved.clientId}`,
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, webQuote: updated });
}
