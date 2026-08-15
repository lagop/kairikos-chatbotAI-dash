import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/web-quote/request
 *
 * Free — the client asks for a custom 'web' quote, no payment involved
 * at this step. Creates (or reactivates, if a prior request was
 * cancelled) the 'web' ClientProduct in 'quote_pending', which is what
 * unlocks the brief + /portal/web (see canAccessWebProduct). Rejects if
 * the client already has a 'web' row in any status OTHER than
 * 'cancelled' — including 'active', where they should never see this
 * button in the first place (defense in depth, mirrors the checkout
 * route's own guard against a stale UI state).
 */
export async function POST() {
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const product = await prisma.product.findFirst({ where: { code: 'web', isActive: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { id: true, tenantId: true },
  });
  if (!client || !client.tenantId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'client_has_no_tenant' }, { status: 503 });
  }

  const existing = await prisma.clientProduct.findUnique({
    where: { clientId_productId: { clientId: resolved.clientId, productId: product.id } },
    select: { status: true },
  });
  if (existing && existing.status !== 'cancelled') {
    return NextResponse.json({ error: 'already_requested' }, { status: 409 });
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.clientProduct.upsert({
      where: { clientId_productId: { clientId: resolved.clientId, productId: product.id } },
      create: { clientId: resolved.clientId, productId: product.id, tenantId: client.tenantId!, status: 'quote_pending' },
      update: { status: 'quote_pending', cancelledAt: null },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: row.id,
        clientId: resolved.clientId,
        productId: product.id,
        tenantId: client.tenantId,
        action: 'web_quote_requested',
        statusBefore: existing?.status ?? null,
        statusAfter: 'quote_pending',
        actorId: `client:${resolved.clientId}`,
      },
    });
  });

  return NextResponse.json({ status: 'quote_pending' });
}
