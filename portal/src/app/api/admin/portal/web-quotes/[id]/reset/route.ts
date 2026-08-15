import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/web-quotes/[id]/reset
 *
 * Reopens a cancelled quote back to 'draft' so the operator can try
 * again — reuses the same row (1:1 with ClientProduct) rather than
 * creating a new one; the full history survives in WebQuoteAudit either
 * way. No TOTP — this doesn't commit anything, same reasoning as
 * creating/editing a draft.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (webQuote.status !== 'cancelled') {
    return NextResponse.json({ error: 'not_cancelled' }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'draft', cancelledAt: null, sentAt: null, sentByOperatorId: null, acceptedAt: null },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'reset_to_draft',
        before: { status: 'cancelled' },
        after: { status: 'draft' },
        actorOperatorId: auth.operatorId,
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, webQuote: updated });
}
