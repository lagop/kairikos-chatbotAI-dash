import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { MAX_TRIAL_MONTHS, normalizeMonthlyCents } from '@/lib/custom-care-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z
  .object({
    clientProductId: z.string().uuid(),
    amountCents: z.number().int().nonnegative(),
    // WebQuote v2 — optional operator-entered advance/deposit. When set,
    // billing splits into a deposit invoice + a final-balance invoice
    // instead of a single invoice for the full amount (see
    // resolveDepositPlan in web-quotes.ts). Must leave a positive balance.
    depositCents: z.number().int().positive().optional(),
    currency: z.string().min(1).optional(),
    description: z.string().min(1),
    // 11/11/2026 — cuota mensual de mantenimiento (lib/custom-care.ts). null o
    // 0 = sin mantenimiento; se guarda como null, no existe una cuota de 0 €.
    monthlyCents: z.number().int().nonnegative().nullable().optional(),
    // Meses que no se cobra desde que el cliente la activa (12 = el año de
    // alojamiento incluido). Tope 24: Stripe no admite más de 730 días.
    monthlyStartsAfterMonths: z.number().int().min(0).max(MAX_TRIAL_MONTHS).optional(),
  })
  .refine((v) => v.depositCents === undefined || v.depositCents < v.amountCents, {
    message: 'deposit_must_be_less_than_amount',
    path: ['depositCents'],
  });

/**
 * POST /api/admin/portal/web-quotes
 *
 * First-time creation of a draft WebQuote for one specific 'web' project
 * (ClientProduct.status='quote_pending' — created by POST
 * /api/portal/web-quote/request). No TOTP — a draft commits nothing,
 * "Enviar al cliente" is the compromising action.
 *
 * WP-XX — takes clientProductId directly instead of resolving "the"
 * web ClientProduct from clientId + code: a client can have multiple
 * 'web' projects (see ClientProduct's schema comment), so the operator
 * must always specify which one.
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
    where: { id: body.data.clientProductId, product: { code: 'web' } },
    select: { id: true, clientId: true, tenantId: true, status: true },
  });
  if (!clientProduct) return NextResponse.json({ error: 'client_product_not_found' }, { status: 404 });
  if (clientProduct.status !== 'quote_pending') {
    return NextResponse.json({ error: 'not_quote_pending' }, { status: 409 });
  }

  const existing = await prisma.webQuote.findUnique({ where: { clientProductId: clientProduct.id } });
  if (existing) {
    return NextResponse.json({ error: 'quote_already_exists', webQuoteId: existing.id }, { status: 409 });
  }

  const { operatorId } = auth;

  const webQuote = await prisma.$transaction(async (tx) => {
    const created = await tx.webQuote.create({
      data: {
        clientId: clientProduct.clientId,
        clientProductId: clientProduct.id,
        tenantId: clientProduct.tenantId,
        amountCents: body.data.amountCents,
        depositCents: body.data.depositCents ?? null,
        currency: body.data.currency ?? 'eur',
        description: body.data.description,
        monthlyCents: normalizeMonthlyCents(body.data.monthlyCents),
        ...(body.data.monthlyStartsAfterMonths !== undefined ? { monthlyStartsAfterMonths: body.data.monthlyStartsAfterMonths } : {}),
        createdByOperatorId: operatorId,
      },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: created.id,
        action: 'created',
        after: {
          amountCents: created.amountCents,
          depositCents: created.depositCents,
          currency: created.currency,
          description: created.description,
          monthlyCents: created.monthlyCents,
          monthlyStartsAfterMonths: created.monthlyStartsAfterMonths,
        },
        actorOperatorId: operatorId,
      },
    });
    return created;
  });

  return NextResponse.json({ ok: true, webQuote }, { status: 201 });
}
