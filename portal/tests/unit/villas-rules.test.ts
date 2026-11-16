// Reserva propia para villas — ciclo de una solicitud, disponibilidad y la
// clave de Stripe del dueño (request-rules.ts, availability.ts, stripe-deposit.ts).
import { describe, expect, it, vi } from 'vitest';
import {
  canTransition,
  checkoutExpiry,
  generateGuestToken,
  generatePublicToken,
  generateReference,
  isBlocking,
  slugify,
} from '@/lib/villas/request-rules';
import { buildCalendar, conflictsFor, fromPriceCents, isRangeFree, type BusyRange } from '@/lib/villas/availability';
import { classifyStripeKey, createDepositCheckout, readCheckoutSession, type DepositStripe } from '@/lib/villas/stripe-deposit';

describe('transiciones', () => {
  it('solo las del diagrama', () => {
    expect(canTransition('pending', 'accepted')).toBe(true);
    expect(canTransition('pending', 'confirmed')).toBe(false); // no se cobra sin aceptar
    expect(canTransition('accepted', 'confirmed')).toBe(true);
    expect(canTransition('declined', 'accepted')).toBe(false);
    expect(canTransition('confirmed', 'expired')).toBe(false); // pagada no caduca
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('inventado', 'accepted')).toBe(false);
  });

  it('bloquean fechas las confirmadas y las aceptadas dentro de plazo', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(isBlocking({ status: 'confirmed', paymentDueAt: null }, now)).toBe(true);
    expect(isBlocking({ status: 'accepted', paymentDueAt: new Date('2026-11-16T12:00:00Z') }, now)).toBe(true);
    expect(isBlocking({ status: 'accepted', paymentDueAt: new Date('2026-11-15T11:00:00Z') }, now)).toBe(false);
    expect(isBlocking({ status: 'pending', paymentDueAt: null }, now)).toBe(false);
  });
});

describe('checkoutExpiry', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  it('la sesión de Stripe nunca vive más que el plazo de pago', () => {
    const due = new Date('2026-11-15T20:00:00Z');
    expect(checkoutExpiry(due, now)).toEqual({ expiresAt: due, extendDueTo: null });
  });
  it('y como mucho 23,5 h, lo que deja Stripe', () => {
    const r = checkoutExpiry(new Date('2026-11-17T12:00:00Z'), now);
    expect(r.expiresAt.toISOString()).toBe('2026-11-16T11:30:00.000Z');
  });
  it('si quedan menos de 30 min, usa el mínimo de Stripe y alarga el plazo', () => {
    const r = checkoutExpiry(new Date('2026-11-15T12:10:00Z'), now);
    expect(r.expiresAt.getTime() - now.getTime()).toBe(31 * 60 * 1000);
    expect(r.extendDueTo).toEqual(r.expiresAt);
  });
});

describe('identificadores', () => {
  it('referencias que se pueden dictar', () => {
    for (let i = 0; i < 50; i++) expect(generateReference()).toMatch(/^VR-[2-9A-HJKMNP-Z]{6}$/);
  });
  it('tokens largos y con prefijo', () => {
    expect(generateGuestToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generatePublicToken('vil')).toMatch(/^vil_[A-Za-z0-9_-]{24}$/);
    expect(generatePublicToken('ical')).toMatch(/^ical_/);
  });
  it('slug para ?unidad=', () => {
    expect(slugify('Villa Castaño')).toBe('villa-castano');
    expect(slugify('  ¡Ñ!  ')).toBe('n');
    expect(slugify('***')).toBe('villa');
  });
});

describe('disponibilidad', () => {
  const busy: BusyRange[] = [
    { start: '2026-12-14', end: '2026-12-21', kind: 'ical', id: 'b1', label: 'Airbnb' },
    { start: '2026-12-24', end: '2026-12-26', kind: 'request', id: 'r1' },
  ];
  it('una entrada el día de una salida está libre', () => {
    expect(isRangeFree(busy, '2026-12-21', '2026-12-24')).toBe(true);
    expect(isRangeFree(busy, '2026-12-20', '2026-12-22')).toBe(false);
    expect(conflictsFor(busy, '2026-12-10', '2026-12-30').map((b) => b.id)).toEqual(['b1', 'r1']);
  });

  it('el calendario marca ocupadas, pasadas y fuera de plazo', () => {
    const villa = { nightlyCents: 18_000, minNights: 2, cleaningFeeCents: 0, vatRateBps: 1000, touristTaxCents: 0, maxGuests: 4 };
    const days = buildCalendar(villa, [], busy, '2026-12-12', '2026-12-16', '2026-12-13');
    expect(days.map((d) => [d.date, d.available])).toEqual([
      ['2026-12-12', false], // ayer
      ['2026-12-13', true],
      ['2026-12-14', false],
      ['2026-12-15', false],
    ]);
    expect(days[1].nightlyCents).toBe(18_000);
  });

  it('el precio «desde» ignora temporadas ya terminadas', () => {
    const villa = { nightlyCents: 18_000, minNights: 2, cleaningFeeCents: 0, vatRateBps: 1000, touristTaxCents: 0, maxGuests: 4 };
    const seasons = [
      { name: 'Vieja', startDate: '2026-01-01', endDate: '2026-02-01', nightlyCents: 9_000, minNights: 2 },
      { name: 'Invierno', startDate: '2026-11-01', endDate: '2027-02-01', nightlyCents: 15_000, minNights: 2 },
    ];
    expect(fromPriceCents(villa, seasons, '2026-11-15')).toBe(15_000);
  });
});

describe('clave de Stripe del dueño', () => {
  it('solo test mientras no se active el modo real', () => {
    expect(classifyStripeKey('rk_test_' + 'a'.repeat(24), false)).toEqual({ ok: true, mode: 'test', hint: 'aaaa' });
    expect(classifyStripeKey('sk_live_' + 'a'.repeat(24), false)).toEqual({ ok: false, error: 'live_not_allowed' });
    expect(classifyStripeKey('sk_live_' + 'b'.repeat(24), true)).toMatchObject({ ok: true, mode: 'live' });
    expect(classifyStripeKey('pk_test_' + 'a'.repeat(24), true)).toEqual({ ok: false, error: 'publishable_key' });
    expect(classifyStripeKey('hola', true)).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('VILLAS_STRIPE_LIVE_ENABLED vacía cuenta como apagada', () => {
    vi.stubEnv('VILLAS_STRIPE_LIVE_ENABLED', '');
    expect(classifyStripeKey('sk_live_' + 'a'.repeat(24))).toEqual({ ok: false, error: 'live_not_allowed' });
    vi.stubEnv('VILLAS_STRIPE_LIVE_ENABLED', 'true');
    expect(classifyStripeKey('sk_live_' + 'a'.repeat(24))).toMatchObject({ ok: true });
    vi.unstubAllEnvs();
  });
});

function fakeStripe(session: Record<string, unknown> = {}) {
  const sessions = {
    create: vi.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    retrieve: vi.fn().mockResolvedValue({ id: 'cs_test_1', status: 'open', payment_status: 'unpaid', ...session }),
    expire: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ data: [] }),
  };
  return { stripe: { checkout: { sessions } } as unknown as DepositStripe, sessions };
}

describe('Checkout del depósito', () => {
  it('cobra el depósito de la solicitud, con su referencia y caducidad', async () => {
    const { stripe, sessions } = fakeStripe();
    const expiresAt = new Date('2026-11-16T10:00:00Z');
    const res = await createDepositCheckout(stripe, {
      requestId: 'req-1',
      reference: 'VR-ABC234',
      guestEmail: 'ana@correo.example',
      depositCents: 48_900,
      currency: 'EUR',
      productName: 'Depósito · Villa Alcornoque',
      description: 'lun, 14 dic 2026 – lun, 21 dic 2026 · VR-ABC234',
      lang: 'es',
      successUrl: 'https://portal.example/reserva-villa/t?pago=ok&session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://portal.example/reserva-villa/t?pago=cancelado',
      expiresAt,
      attempt: 7,
    });
    expect(res).toEqual({ ok: true, sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const [params, options] = sessions.create.mock.calls[0];
    expect(params).toMatchObject({
      mode: 'payment',
      client_reference_id: 'req-1',
      customer_email: 'ana@correo.example',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 48_900 } }],
    });
    expect(options).toEqual({ idempotencyKey: 'villa-deposit-req-1-7' });
  });

  it('una sesión pagada dice qué pago y qué solicitud', async () => {
    const { stripe } = fakeStripe({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 48_900, client_reference_id: 'req-1' });
    expect(await readCheckoutSession(stripe, 'cs_test_1')).toEqual({ state: 'paid', paymentIntentId: 'pi_1', amountTotal: 48_900, requestId: 'req-1' });
  });

  it('abierta, caducada o con error', async () => {
    expect(await readCheckoutSession(fakeStripe().stripe, 'cs')).toEqual({ state: 'open' });
    expect(await readCheckoutSession(fakeStripe({ status: 'expired' }).stripe, 'cs')).toEqual({ state: 'expired' });
    const { stripe, sessions } = fakeStripe();
    sessions.retrieve.mockRejectedValueOnce(new Error('boom'));
    expect(await readCheckoutSession(stripe, 'cs')).toEqual({ state: 'error', error: 'stripe_error' });
  });
});
