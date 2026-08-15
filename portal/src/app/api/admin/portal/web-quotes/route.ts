import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  clientId: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().min(1).optional(),
  description: z.string().min(1),
});

/**
 * POST /api/admin/portal/web-quotes
 *
 * First-time creation of a draft WebQuote for a client already in the
 * 'web' quote flow (ClientProduct.status='quote_pending' — created by
 * POST /api/portal/web-quote/request). No TOTP — a draft commits
 * nothing, "Enviar al cliente" is the compromising action.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId: body.data.clientId, product: { code: 'web' } },
    select: { id: true, tenantId: true, status: true },
  });
  if (!clientProduct) return NextResponse.json({ error: 'client_product_not_found' }, { status: 404 });
  if (clientProduct.status !== 'quote_pending') {
    return NextResponse.json({ error: 'not_quote_pending' }, { status: 409 });
  }

  const existing = await prisma.webQuote.findUnique({ where: { clientProductId: clientProduct.id } });
  if (existing) {
    return NextResponse.json({ error: 'quote_already_exists', webQuoteId: existing.id }, { status: 409 });
  }

  const webQuote = await prisma.$transaction(async (tx) => {
    const created = await tx.webQuote.create({
      data: {
        clientId: body.data.clientId,
        clientProductId: clientProduct.id,
        tenantId: clientProduct.tenantId,
        amountCents: body.data.amountCents,
        currency: body.data.currency ?? 'eur',
        description: body.data.description,
        createdByOperatorId: auth.operatorId,
      },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: created.id,
        action: 'created',
        after: { amountCents: created.amountCents, currency: created.currency, description: created.description },
        actorOperatorId: auth.operatorId,
      },
    });
    return created;
  });

  return NextResponse.json({ ok: true, webQuote }, { status: 201 });
}
