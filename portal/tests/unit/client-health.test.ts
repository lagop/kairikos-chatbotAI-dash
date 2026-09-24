// =============================================================================
// A8 y A6 — unit tests de las señales de riesgo de baja y de venta cruzada.
//
// Las dos reglas viven en funciones puras porque lo que hay que fijar son los
// CRITERIOS, no las consultas:
//
// - Un cliente recién activado que aún no ha usado nada NO está en riesgo:
//   los primeros días son el alta, no el abandono. Confundirlos haría que
//   cada cliente nuevo generara una alarma el mismo día de contratar.
// - Quien no tiene nada activo no aparece por ningún lado: ni riesgo ni
//   oferta. Ya se fue o todavía no ha llegado.
// - Las ofertas se disparan por USO y no por calendario: ofrecerle reseñas a
//   quien no ha recuperado ninguna llamada es ruido.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { detectChurnRisks, detectUpsells, ZERO_USE_DAYS, NO_LOGIN_DAYS } from '@/lib/client-health';

const NOW = new Date('2026-09-24T10:00:00Z');

function cliente(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: 'Fontanería Ejemplo',
    lastLoginAt: new Date('2026-09-23T10:00:00Z'),
    products: [{ code: 'recall', status: 'active', subscriptionStatus: 'active' }],
    callsLast14: 12,
    callsTotal: 80,
    reviewsTotal: 4,
    leadsLast14: 2,
    ...over,
  } as Parameters<typeof detectChurnRisks>[0];
}

describe('detectChurnRisks', () => {
  it('un cliente sano no dispara nada', () => {
    expect(detectChurnRisks(cliente(), NOW)).toEqual([]);
  });

  it('sin productos activos no se mira nada: ya se fue', () => {
    const risks = detectChurnRisks(
      cliente({ products: [{ code: 'recall', status: 'cancelled', subscriptionStatus: null }], callsLast14: 0 }),
      NOW,
    );
    expect(risks).toEqual([]);
  });

  it('cero llamadas en 14 días habiéndolas tenido antes es la señal que más tiempo da', () => {
    const risks = detectChurnRisks(cliente({ callsLast14: 0, callsTotal: 80 }), NOW);
    expect(risks.map((r) => r.reason)).toContain('sin_uso');
    expect(risks[0].detail).toContain(String(ZERO_USE_DAYS));
  });

  it('un cliente recién activado que aún no ha usado nada NO está en riesgo', () => {
    const risks = detectChurnRisks(cliente({ callsLast14: 0, callsTotal: 0 }), NOW);
    expect(risks.map((r) => r.reason)).not.toContain('sin_uso');
  });

  it('una suscripción impagada avisa, que es lo que no hacía nadie', () => {
    const risks = detectChurnRisks(
      cliente({ products: [{ code: 'recall', status: 'active', subscriptionStatus: 'past_due' }] }),
      NOW,
    );
    expect(risks.map((r) => r.reason)).toContain('pago_fallido');
  });

  it('un mes sin entrar al portal también cuenta', () => {
    const hace40 = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    const risks = detectChurnRisks(cliente({ lastLoginAt: hace40 }), NOW);
    expect(risks.map((r) => r.reason)).toContain('sin_entrar');
    expect(risks.find((r) => r.reason === 'sin_entrar')!.detail).toContain('40 días');
  });

  it('quien nunca ha entrado no dispara esa señal: puede que el alta sea de hoy', () => {
    const risks = detectChurnRisks(cliente({ lastLoginAt: null }), NOW);
    expect(risks.map((r) => r.reason)).not.toContain('sin_entrar');
  });

  it('justo en el umbral ya avisa, no un día después', () => {
    const justo = new Date(NOW.getTime() - NO_LOGIN_DAYS * 24 * 60 * 60 * 1000);
    expect(detectChurnRisks(cliente({ lastLoginAt: justo }), NOW).map((r) => r.reason)).toContain('sin_entrar');
  });
});

describe('detectUpsells', () => {
  it('a quien usa recall y no tiene reviews, se le ofrece reviews', () => {
    const rows = detectUpsells(cliente({ callsTotal: 20 }));
    expect(rows.map((r) => r.productCode)).toContain('reviews');
    expect(rows[0].reason).toContain('20');
  });

  it('pero no antes de que el producto haya dado algo', () => {
    expect(detectUpsells(cliente({ callsTotal: 2 })).map((r) => r.productCode)).not.toContain('reviews');
  });

  it('no se ofrece lo que ya tiene contratado', () => {
    const rows = detectUpsells(
      cliente({
        callsTotal: 50,
        products: [
          { code: 'recall', status: 'active', subscriptionStatus: 'active' },
          { code: 'reviews', status: 'active', subscriptionStatus: 'active' },
        ],
      }),
    );
    expect(rows.map((r) => r.productCode)).not.toContain('reviews');
  });

  it('con reputación ganada se ofrece la web', () => {
    const rows = detectUpsells(
      cliente({
        reviewsTotal: 40,
        products: [{ code: 'reviews', status: 'active', subscriptionStatus: 'active' }],
      }),
    );
    expect(rows.map((r) => r.productCode)).toContain('web');
  });

  it('a quien le entran muchos contactos y no tiene bandeja, se le ofrece leads', () => {
    const rows = detectUpsells(cliente({ leadsLast14: 15 }));
    expect(rows.map((r) => r.productCode)).toContain('leads');
  });

  it('quien ya tiene prospecting no necesita leads: comparten bandeja', () => {
    const rows = detectUpsells(
      cliente({
        leadsLast14: 15,
        products: [{ code: 'prospecting', status: 'active', subscriptionStatus: 'active' }],
      }),
    );
    expect(rows.map((r) => r.productCode)).not.toContain('leads');
  });

  it('un cliente sin nada activo no recibe ofertas', () => {
    expect(detectUpsells(cliente({ products: [] }))).toEqual([]);
  });
});
