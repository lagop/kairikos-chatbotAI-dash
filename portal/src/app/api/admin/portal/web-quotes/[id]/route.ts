import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { canEditWebQuote } from '@/lib/web-quotes';
import { MAX_TRIAL_MONTHS, normalizeMonthlyCents } from '@/lib/custom-care-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  amountCents: z.number().int().nonnegative().optional(),
  // WebQuote v2 — null explicitly clears a previously-set deposit
  // (reverts to a single full-amount invoice); omitted leaves it as-is.
  depositCents: z.number().int().positive().nullable().optional(),
  description: z.string().min(1).optional(),
    // 11/11/2026 — cuota mensual de mantenimiento (lib/custom-care.ts). null o
    // 0 = sin mantenimiento; se guarda como null, no existe una cuota de 0 €.
    monthlyCents: z.number().int().nonnegative().nullable().optional(),
    // Meses que no se cobra desde que el cliente la activa (12 = el año de
    // alojamiento incluido). Tope 24: Stripe no admite más de 730 días.
    monthlyStartsAfterMonths: z.number().int().min(0).max(MAX_TRIAL_MONTHS).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: 'at_least_one_field_required',
});

/**
 * PATCH /api/admin/portal/web-quotes/[id]
 *
 * Edits the amount/description of a quote still in 'draft' or 'sent'.
 * No TOTP — editing doesn't commit anything by itself; re-sending after
 * an edit (POST .../send) is the compromising step and requires it.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const webQuote = await prisma.webQuote.findUnique({ where: { id: params.id } });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  if (!canEditWebQuote(webQuote.status)) {
    return NextResponse.json({ error: 'quote_locked' }, { status: 409 });
  }

  const effectiveAmountCents = body.data.amountCents ?? webQuote.amountCents;
  const effectiveDepositCents = body.data.depositCents !== undefined ? body.data.depositCents : webQuote.depositCents;
  if (effectiveDepositCents !== null && effectiveDepositCents >= effectiveAmountCents) {
    return NextResponse.json({ error: 'invalid_body', details: 'deposit_must_be_less_than_amount' }, { status: 400 });
  }

  const { operatorId } = auth;

  const before = {
    amountCents: webQuote.amountCents,
    depositCents: webQuote.depositCents,
    description: webQuote.description,
    monthlyCents: webQuote.monthlyCents,
    monthlyStartsAfterMonths: webQuote.monthlyStartsAfterMonths,
  };
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: {
        amountCents: effectiveAmountCents,
        depositCents: effectiveDepositCents,
        description: body.data.description ?? webQuote.description,
        ...(body.data.monthlyCents !== undefined ? { monthlyCents: normalizeMonthlyCents(body.data.monthlyCents) } : {}),
        ...(body.data.monthlyStartsAfterMonths !== undefined ? { monthlyStartsAfterMonths: body.data.monthlyStartsAfterMonths } : {}),
      },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'edited',
        before,
        after: {
          amountCents: row.amountCents,
          depositCents: row.depositCents,
          description: row.description,
          monthlyCents: row.monthlyCents,
          monthlyStartsAfterMonths: row.monthlyStartsAfterMonths,
        },
        actorOperatorId: operatorId,
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, webQuote: updated });
}
