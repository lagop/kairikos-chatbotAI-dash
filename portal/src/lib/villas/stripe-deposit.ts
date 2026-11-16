import 'server-only';
import Stripe from 'stripe';
import type { VillaRental } from '@prisma/client';
import { decryptBuffer, encryptBuffer, parseHexKey, type EncryptedBuffer } from '@/lib/operator-crypto';
import { getStripeApiVersion } from '@/lib/stripe';

// =============================================================================
// Reserva propia para villas — el depósito con Stripe Checkout.
//
// El depósito es dinero DEL DUEÑO, no de Kairikos: no puede ir a la cuenta de
// Stripe del portal (lib/stripe.ts). Decisión de esta versión
// (docs/plan-reserva-villas.md, «Stripe»): el dueño crea en su Stripe una
// clave restringida con «Checkout Sessions: escritura» y la pega en el panel.
// Se guarda cifrada con su propia clave de cifrado
// (VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY): es otra clase de secreto que las
// claves de Stripe del operador.
//
// SOLO MODO TEST mientras VILLAS_STRIPE_LIVE_ENABLED no valga 'true'. Activar
// cobros reales es una decisión del propietario, no de un despliegue: el
// código rechaza una clave live al guardarla y también al usarla.
//
// Sin webhooks: con una cuenta de Stripe por dueño habría que configurar un
// endpoint en cada una. El pago se comprueba leyendo la sesión al volver de
// Checkout (/reserva-villa/<token>?session_id=…) y el cron repasa las abiertas
// (sweep.ts). Si algún día se pasa a Stripe Connect, solo cambia este archivo.
//
// La web del cliente nunca ve una tarjeta: el huésped paga en la página de
// Stripe.
// =============================================================================

export type StripeKeyMode = 'test' | 'live';

export function isLiveModeAllowed(): boolean {
  return (process.env.VILLAS_STRIPE_LIVE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export type ClassifyKeyResult =
  | { ok: true; mode: StripeKeyMode; hint: string }
  | { ok: false; error: 'invalid_key' | 'publishable_key' | 'live_not_allowed' };

/** sk_/rk_ de test o live. Una pk_ es la clave pública: no sirve para crear
 *  sesiones y es el error más probable al copiar del panel de Stripe. */
export function classifyStripeKey(raw: string, liveAllowed = isLiveModeAllowed()): ClassifyKeyResult {
  const key = raw.trim();
  if (/^pk_(test|live)_/.test(key)) return { ok: false, error: 'publishable_key' };
  const m = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/.exec(key);
  if (!m) return { ok: false, error: 'invalid_key' };
  const mode = m[2] as StripeKeyMode;
  if (mode === 'live' && !liveAllowed) return { ok: false, error: 'live_not_allowed' };
  return { ok: true, mode, hint: key.slice(-4) };
}

function encryptionKey(): Buffer {
  return parseHexKey('VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY', process.env.VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY);
}

export function encryptStripeKey(raw: string): EncryptedBuffer {
  return encryptBuffer(raw.trim(), encryptionKey());
}

type RentalKeyColumns = Pick<VillaRental, 'stripeKeyCiphertext' | 'stripeKeyIv' | 'stripeKeyTag' | 'stripeKeyMode'>;

export function hasStripeKey(rental: RentalKeyColumns): boolean {
  return Boolean(rental.stripeKeyCiphertext && rental.stripeKeyIv && rental.stripeKeyTag);
}

/** El cliente de Stripe del dueño, o null si no hay clave, no se puede
 *  descifrar, o es live sin permiso. Nunca lanza. */
export function stripeForRental(rental: RentalKeyColumns): Stripe | null {
  if (!rental.stripeKeyCiphertext || !rental.stripeKeyIv || !rental.stripeKeyTag) return null;
  if (rental.stripeKeyMode === 'live' && !isLiveModeAllowed()) return null;
  let key: string;
  try {
    key = decryptBuffer(
      { ciphertext: Buffer.from(rental.stripeKeyCiphertext), iv: Buffer.from(rental.stripeKeyIv), tag: Buffer.from(rental.stripeKeyTag) },
      encryptionKey(),
    );
  } catch {
    return null;
  }
  // Doble cerrojo: aunque la columna dijera 'test', una clave live no se usa.
  const classified = classifyStripeKey(key);
  if (!classified.ok) return null;
  return new Stripe(key, {
    apiVersion: getStripeApiVersion() as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: { name: 'kairikos-portal-villas', version: '0.1.0' },
  });
}

/** Lo mínimo de Stripe que usa este módulo: así los tests pasan un doble. */
export type DepositStripe = { checkout: { sessions: Pick<Stripe['checkout']['sessions'], 'create' | 'retrieve' | 'expire' | 'list'> } };

/** Comprueba que la clave sirve antes de guardarla (lista una sesión). */
export async function verifyStripeKey(stripe: DepositStripe): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await stripe.checkout.sessions.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    const code = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : 'stripe_error';
    return { ok: false, error: String(code) };
  }
}

export interface DepositCheckoutInput {
  requestId: string;
  reference: string;
  guestEmail: string;
  depositCents: number;
  currency: string;
  /** «Depósito · Villa Alcornoque · 14–21 dic 2026» */
  productName: string;
  description: string;
  lang: 'es' | 'en';
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  /** Cambia en cada intento: la clave de idempotencia de Stripe dura 24 h y
   *  una sesión caducada no se puede reutilizar. */
  attempt: number;
}

export type DepositCheckoutResult = { ok: true; sessionId: string; url: string } | { ok: false; error: string };

export async function createDepositCheckout(stripe: DepositStripe, input: DepositCheckoutInput): Promise<DepositCheckoutResult> {
  try {
    const metadata = { kairikos: 'villas', villa_request_id: input.requestId, reference: input.reference };
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: input.guestEmail,
        locale: input.lang,
        client_reference_id: input.requestId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.depositCents,
              product_data: { name: input.productName, description: input.description },
            },
          },
        ],
        payment_intent_data: { description: `${input.productName} (${input.reference})`, metadata },
        metadata,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: `villa-deposit-${input.requestId}-${input.attempt}` },
    );
    if (!session.url) return { ok: false, error: 'no_checkout_url' };
    return { ok: true, sessionId: session.id, url: session.url };
  } catch (err) {
    const code = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : 'stripe_error';
    return { ok: false, error: String(code) };
  }
}

export type SessionState =
  | { state: 'paid'; paymentIntentId: string | null; amountTotal: number | null; requestId: string | null }
  | { state: 'open' | 'expired' | 'unpaid' }
  | { state: 'error'; error: string };

export async function readCheckoutSession(stripe: DepositStripe, sessionId: string): Promise<SessionState> {
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null);
      return { state: 'paid', paymentIntentId: pi, amountTotal: s.amount_total, requestId: s.client_reference_id };
    }
    if (s.status === 'open') return { state: 'open' };
    if (s.status === 'expired') return { state: 'expired' };
    return { state: 'unpaid' };
  } catch (err) {
    const code = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : 'stripe_error';
    return { state: 'error', error: String(code) };
  }
}

/** Cierra una sesión abierta (cuando caduca el plazo de pago). Si Stripe dice
 *  que ya no está abierta, quien llama vuelve a leerla: puede que se pagara. */
export async function expireCheckoutSession(stripe: DepositStripe, sessionId: string): Promise<boolean> {
  try {
    await stripe.checkout.sessions.expire(sessionId);
    return true;
  } catch {
    return false;
  }
}
