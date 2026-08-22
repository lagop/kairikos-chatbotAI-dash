import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/web-quote/request
 *
 * Free — the client asks for a custom 'web' quote, no payment involved
 * at this step. Creates a NEW 'web' ClientProduct row in 'quote_pending',
 * which is what unlocks that project's brief + /portal/web/[id] (see
 * canAccessWebProduct). WP-XX — a client can have multiple independent
 * 'web' projects (see ClientProduct's schema comment), so this always
 * creates a fresh row rather than reactivating an old cancelled one
 * (reusing an id would conflate two separate WebBrief/WebQuote histories
 * under one ClientProduct id, since both are 1:1-keyed to it). The only
 * thing this rejects is a SECOND request while one is already mid-
 * negotiation — 'quote_pending' covers the entire pre-payment stretch
 * (see that status's schema comment) — an 'active'/'paused'/'past_due'
 * project elsewhere for the same client never blocks a new one.
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

  const product = await prisma.product.findFirst({ where: { code: 'web', isActive: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { id: true, tenantId: true },
  });
  if (!client || !client.tenantId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'client_has_no_tenant' }, { status: 503 });
  }

  // Only an in-flight negotiation blocks a new request — an 'active' or
  // 'paused' project elsewhere for this client is fine, that's the whole
  // point of supporting multiple projects.
  const inFlight = await prisma.clientProduct.findFirst({
    where: { clientId: resolved.clientId, productId: product.id, status: 'quote_pending' },
    select: { id: true },
  });
  if (inFlight) {
    return NextResponse.json({ error: 'already_requested' }, { status: 409 });
  }

  const clientProductId = await prisma.$transaction(async (tx) => {
    const row = await tx.clientProduct.create({
      data: { clientId: resolved.clientId, productId: product.id, tenantId: client.tenantId!, status: 'quote_pending' },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: row.id,
        clientId: resolved.clientId,
        productId: product.id,
        tenantId: client.tenantId,
        action: 'web_quote_requested',
        statusBefore: null,
        statusAfter: 'quote_pending',
        actorId: `client:${resolved.clientId}`,
      },
    });
    return row.id;
  });

  return NextResponse.json({ status: 'quote_pending', clientProductId });
}
