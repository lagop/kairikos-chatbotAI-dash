import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireVillaPortal } from '@/lib/villas/portal-auth';
import { auditVilla } from '@/lib/villas/rental';
import { CONFIRM_HOURS_RANGE, DEPOSIT_PERCENT_RANGE, PAYMENT_HOURS_RANGE } from '@/lib/villas/request-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/portal/villas — las condiciones del dueño: nombre con el que
 * firma, avisos, plazos, depósito y las dos frases que lee el huésped antes de
 * pagar. Reserva propia para villas, docs/plan-reserva-villas.md.
 *
 * Cambiar el depósito o los plazos no toca las solicitudes ya enviadas: cada
 * una lleva su presupuesto congelado y sus fechas límite calculadas al crearse
 * o aceptarse.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

const BodySchema = z
  .object({
    businessName: z.string().trim().min(2).max(100).optional(),
    ownerEmail: z.union([z.string().trim().email().max(200), z.literal(''), z.null()]).optional().transform((v) => (v === undefined ? undefined : v || null)),
    ownerPhone: optionalText(40),
    siteUrl: z
      .union([z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u)), z.literal(''), z.null()])
      .optional()
      .transform((v) => (v === undefined ? undefined : v || null)),
    timeZone: z.enum(['Europe/Madrid', 'Atlantic/Canary']).optional(),
    depositPercent: z.number().int().min(DEPOSIT_PERCENT_RANGE.min).max(DEPOSIT_PERCENT_RANGE.max).optional(),
    confirmHours: z.number().int().min(CONFIRM_HOURS_RANGE.min).max(CONFIRM_HOURS_RANGE.max).optional(),
    paymentHours: z.number().int().min(PAYMENT_HOURS_RANGE.min).max(PAYMENT_HOURS_RANGE.max).optional(),
    balanceNote: optionalText(400),
    cancellationNote: optionalText(400),
  })
  .strict();

export async function PATCH(req: NextRequest) {
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', fields: Object.keys(body.error.flatten().fieldErrors) }, { status: 400 });

  const data = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });
  await prisma.villaRental.update({ where: { id: ctx.rental.id }, data });
  await auditVilla(prisma, {
    rentalId: ctx.rental.id,
    clientId: ctx.clientId,
    entity: 'rental',
    entityId: ctx.rental.id,
    action: 'settings_updated',
    actor: ctx.actor,
    metadata: { fields: Object.keys(data) },
  });
  return NextResponse.json({ ok: true });
}
