import { NextResponse, type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireVillaPortal } from '@/lib/villas/portal-auth';
import { auditVilla } from '@/lib/villas/rental';
import { classifyStripeKey, encryptStripeKey, verifyStripeKey } from '@/lib/villas/stripe-deposit';
import { getStripeApiVersion } from '@/lib/stripe';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT    /api/portal/villas/stripe   body: { secretKey }
 * DELETE /api/portal/villas/stripe
 *
 * La clave restringida de Stripe del dueño, con la que se cobran SUS depósitos
 * (lib/villas/stripe-deposit.ts explica por qué no la del portal). Antes de
 * guardarla se prueba contra Stripe; se guarda cifrada y la auditoría solo
 * registra el modo y los 4 últimos caracteres.
 *
 * Solo claves de test mientras VILLAS_STRIPE_LIVE_ENABLED no sea 'true'.
 */
const BodySchema = z.object({ secretKey: z.string().trim().min(10).max(300) });

const ERRORS: Record<string, string> = {
  invalid_key: 'Eso no parece una clave secreta de Stripe (empieza por sk_ o rk_).',
  publishable_key: 'Es la clave publicable (pk_). Hace falta la secreta o una restringida (rk_).',
  live_not_allowed: 'Por ahora solo se aceptan claves de prueba (sk_test_ o rk_test_).',
};

export async function PUT(req: NextRequest) {
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const classified = classifyStripeKey(body.data.secretKey);
  if (!classified.ok) return NextResponse.json({ error: classified.error, message: ERRORS[classified.error] }, { status: 400 });

  const stripe = new Stripe(body.data.secretKey, { apiVersion: getStripeApiVersion() as Stripe.LatestApiVersion, typescript: true });
  const verified = await verifyStripeKey(stripe);
  if (!verified.ok) {
    return NextResponse.json(
      { error: 'stripe_rejected', message: `Stripe no acepta la clave (${verified.error}). Si es restringida, necesita «Checkout Sessions: escritura».` },
      { status: 400 },
    );
  }

  let encrypted;
  try {
    encrypted = encryptStripeKey(body.data.secretKey);
  } catch (err) {
    logError('villas.stripe.encrypt_failed', err, { rentalId: ctx.rental.id }, 'error');
    return NextResponse.json({ error: 'encryption_unavailable' }, { status: 503 });
  }
  await prisma.villaRental.update({
    where: { id: ctx.rental.id },
    data: {
      stripeKeyCiphertext: encrypted.ciphertext,
      stripeKeyIv: encrypted.iv,
      stripeKeyTag: encrypted.tag,
      stripeKeyHint: classified.hint,
      stripeKeyMode: classified.mode,
    },
  });
  await auditVilla(prisma, {
    rentalId: ctx.rental.id,
    clientId: ctx.clientId,
    entity: 'rental',
    entityId: ctx.rental.id,
    action: 'stripe_key_set',
    actor: ctx.actor,
    metadata: { mode: classified.mode, hint: classified.hint },
  });
  return NextResponse.json({ ok: true, mode: classified.mode, hint: classified.hint });
}

export async function DELETE() {
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  await prisma.villaRental.update({
    where: { id: ctx.rental.id },
    data: { stripeKeyCiphertext: null, stripeKeyIv: null, stripeKeyTag: null, stripeKeyHint: null, stripeKeyMode: null },
  });
  await auditVilla(prisma, {
    rentalId: ctx.rental.id,
    clientId: ctx.clientId,
    entity: 'rental',
    entityId: ctx.rental.id,
    action: 'stripe_key_removed',
    actor: ctx.actor,
  });
  return NextResponse.json({ ok: true });
}
