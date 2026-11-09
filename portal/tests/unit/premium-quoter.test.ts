import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import defaultData from '@/lib/premium-quoter-default.json';
import { checkAnswers, compute, insightFor, resolveQuoter, type QuoterCatalog, type QuoterData } from '@/lib/premium-quoter-engine';
import { validateQuoterData } from '@/lib/premium-quoter-schema';
import { canMovePremiumQuote, createPremiumQuoteRequest, MAX_REQUESTS_PER_IP_PER_DAY, saveQuoterVersion } from '@/lib/premium-quoter';

// Los importes de /planes/ el día de la integración.
const CATALOG: QuoterCatalog = {
  products: [
    {
      code: 'chatbot',
      tiers: [
        { tier: 'starter', priceCents: 7900, setupFeeCents: 14900 },
        { tier: 'pro', priceCents: 17900, setupFeeCents: 14900 },
      ],
      addons: [],
    },
    { code: 'leads', tiers: [{ tier: 'standard', priceCents: 4900, setupFeeCents: 0 }], addons: [] },
    { code: 'seo', tiers: [{ tier: 'standard', priceCents: 19900, setupFeeCents: 0 }], addons: [{ code: 'gbp_managed', priceCents: 4900 }] },
    { code: 'reviews', tiers: [{ tier: 'basic', priceCents: 9900, setupFeeCents: 0 }], addons: [] },
    { code: 'recall', tiers: [{ tier: 'essential', priceCents: 7900, setupFeeCents: 9900 }], addons: [] },
  ],
};

const raw = defaultData as unknown as QuoterData;

function resolved(catalog: QuoterCatalog = CATALOG, data: QuoterData = raw): QuoterData {
  const r = resolveQuoter(data, catalog);
  if (!r.ok) throw new Error(`faltan: ${r.missing.join(', ')}`);
  return r.quoter;
}

// La sección «Comprobación tras integrar» de la guía.
const CASO_GUIA = {
  tipo: 'nueva',
  paginas: 'p2',
  idiomas: 'i2',
  widgets: ['config', 'anim'],
  contenido: 'c3',
  crecimiento: ['resenas', 'seo'],
  plazo: 'std',
};

describe('compute', () => {
  it('da el caso de «Comprobación tras integrar» con los datos de fábrica y el catálogo', () => {
    const r = compute(resolved(), { sector: 'dental', answers: { sector: 'dental', ...CASO_GUIA } });
    expect(r.list).toBe(11700);
    expect(r.total).toBe(8800);
    expect(r.perMonth).toBe(735);
    expect(r.low).toBe(8100);
    expect(r.high).toBe(9850);
    expect(r.monthly).toBe(298);
    expect(r.weeks).toBe(12);
    expect(r.lines[0]).toEqual(['Web nueva a medida', '3.800 €']);
  });

  it('sin sector no calcula nada', () => {
    const r = compute(resolved(), { sector: null, answers: {} });
    expect(r).toMatchObject({ list: 0, total: 0, monthly: 0, lines: [] });
  });

  it('sin lanzamiento, el total es el precio de lista', () => {
    const q = resolved();
    q.config.launch.enabled = false;
    const r = compute(q, { sector: 'dental', answers: { sector: 'dental', ...CASO_GUIA } });
    expect(r.total).toBe(11700);
  });
});

describe('precios del catálogo', () => {
  it('un cambio en el catálogo llega al presupuesto sin tocar los datos', () => {
    const caro: QuoterCatalog = JSON.parse(JSON.stringify(CATALOG));
    caro.products.find((p) => p.code === 'reviews')!.tiers[0].priceCents = 10900;
    const r = compute(resolved(caro), { sector: 'dental', answers: { sector: 'dental', ...CASO_GUIA } });
    expect(r.monthly).toBe(308);
  });

  it('la ampliación a Pro es la diferencia entre escalones, y también en el texto', () => {
    const q = resolved();
    const ia = q.sectors.dental.widgets.find((w) => w.id === 'ia')!;
    expect(ia.monthly).toBe(100);
    expect(ia.price).toBe(0);
    expect(ia.desc).toContain('179 €/mes');
    expect(ia.desc).not.toContain('{');
    expect(ia.catalog).toBeUndefined();
    expect(q.config.included.join(' ')).toContain('después 79 €/mes');
  });

  it('los datos no llevan escrito a mano ningún precio de catálogo', () => {
    const crecimiento = raw.baseSteps.find((s) => s.id === 'crecimiento')!;
    for (const o of crecimiento.options) {
      expect(o.catalog).toBeDefined();
      expect(o.monthly).toBeUndefined();
      expect(o.price).toBeUndefined();
    }
  });

  it('llamadas recuperadas toma alta y cuota', () => {
    const llamadas = resolved().baseSteps.find((s) => s.id === 'crecimiento')!.options.find((o) => o.id === 'llamadas')!;
    expect(llamadas).toMatchObject({ price: 99, monthly: 79 });
  });

  it('si falta un producto, falla y dice cuál en vez de inventar un precio', () => {
    const sin: QuoterCatalog = { products: CATALOG.products.filter((p) => p.code !== 'reviews') };
    const r = resolveQuoter(raw, sin);
    expect(r).toEqual({ ok: false, missing: ['reviews/basic'] });
  });
});

describe('recomendaciones como datos', () => {
  const q = resolved();
  it('respeta el orden: la primera que cumple', () => {
    expect(insightFor(q, { sector: 'dental', answers: { widgets: ['anim', 'config'] } })).toContain('Combinación ganadora');
    expect(insightFor(q, { sector: 'dental', answers: { widgets: ['anim'] } })).toContain('simulador de financiación');
  });
  it('sin piezas, la sugerencia general', () => {
    expect(insightFor(q, { sector: 'dental', answers: {} })).toContain('las piezas premium');
  });
});

describe('checkAnswers', () => {
  const q = resolved();
  it('acepta el caso de la guía y conserva el sector', () => {
    expect(checkAnswers(q, 'dental', CASO_GUIA)).toEqual({ ok: true, answers: { sector: 'dental', ...CASO_GUIA } });
  });
  it('rechaza una opción inventada', () => {
    expect(checkAnswers(q, 'dental', { ...CASO_GUIA, widgets: ['inventada'] })).toEqual({ ok: false, step: 'widgets' });
  });
  it('rechaza un paso obligatorio sin contestar', () => {
    const { plazo: _omitido, ...sinPlazo } = CASO_GUIA;
    expect(checkAnswers(q, 'dental', sinPlazo)).toEqual({ ok: false, step: 'plazo' });
  });
  it('rechaza un sector que no existe, incluidos los nombres de Object', () => {
    expect(checkAnswers(q, 'constructor', CASO_GUIA)).toEqual({ ok: false, step: 'sector' });
  });
});

describe('validateQuoterData', () => {
  const clone = () => JSON.parse(JSON.stringify(raw)) as QuoterData;
  const problemas = (d: unknown) => {
    const r = validateQuoterData(d);
    return r.ok ? [] : r.problems;
  };

  it('los datos de fábrica son válidos y nacen sin publicar ni prueba social', () => {
    const r = validateQuoterData(raw);
    expect(r.ok).toBe(true);
    expect(raw.config.published).toBe(false);
    expect(raw.config.socialProof).toBeNull();
  });
  it('no deja anunciar 0 plazas con el lanzamiento encendido', () => {
    const d = clone();
    d.config.launch.spotsLeft = 0;
    expect(problemas(d).join()).toMatch(/al menos una plaza/);
  });
  it('rechaza un icono desconocido', () => {
    const d = clone();
    d.sectors.dental.widgets[0].icon = 'nope';
    expect(problemas(d).join()).toMatch(/icono «nope»/);
  });
  it('rechaza un patch a una opción que no existe', () => {
    const d = clone();
    d.sectors.dental.patch.tipo.opts = { fantasma: { label: 'x' } };
    expect(problemas(d).join()).toMatch(/fantasma/);
  });
  it('rechaza una recomendación sobre una pieza que no existe', () => {
    const d = clone();
    d.sectors.dental.insights[0].when.all = ['fantasma'];
    expect(problemas(d).join()).toMatch(/fantasma/);
  });
  it('rechaza que falte un paso que el motor necesita', () => {
    const d = clone();
    d.baseSteps = d.baseSteps.filter((s) => s.id !== 'paginas');
    expect(problemas(d).join()).toMatch(/paginas/);
  });
  it('rechaza una clave desconocida en una opción', () => {
    const d = clone() as unknown as { baseSteps: { options: Record<string, unknown>[] }[] };
    d.baseSteps[0].options[0].precio = 100;
    expect(problemas(d).length).toBeGreaterThan(0);
  });
});

describe('createPremiumQuoteRequest', () => {
  const published = (): QuoterData => {
    const d = JSON.parse(JSON.stringify(raw)) as QuoterData;
    d.config.published = true;
    return d;
  };
  const productRows = CATALOG.products.flatMap((p) => [
    ...p.tiers.map((t) => ({ code: p.code, tier: t.tier, priceCents: t.priceCents, setupFeeCents: t.setupFeeCents, currency: 'eur', selfServeEligible: false, stripeAnnualPriceId: null, kind: 'plan' })),
    ...p.addons.map((a) => ({ code: a.code, tier: 'standard', priceCents: a.priceCents, setupFeeCents: 0, currency: 'eur', selfServeEligible: false, stripeAnnualPriceId: null, kind: 'addon' })),
  ]);

  function mockPrisma(data: QuoterData, counts: { ip?: number; total?: number } = {}) {
    return {
      premiumQuoterVersion: { findFirst: vi.fn(async () => ({ version: 4, data })) },
      product: { findMany: vi.fn(async () => productRows) },
      premiumQuoteRequest: {
        count: vi.fn(async (args: { where: { ipHash?: string } }) => (args.where.ipHash ? (counts.ip ?? 0) : (counts.total ?? 0))),
        create: vi.fn(async () => ({ id: 'q1' })),
      },
    };
  }
  const input = { nombre: 'Ana', empresa: 'Clínica X', email: 'a@x.es', franja: 'Tarde (16–19 h)', sector: 'dental', respuestas: CASO_GUIA, ip: '1.1.1.1' };
  type P = Parameters<typeof createPremiumQuoteRequest>[0];

  beforeEach(() => vi.clearAllMocks());

  it('guarda lo que calcula el servidor, con la versión y el consentimiento', async () => {
    const prisma = mockPrisma(published());
    const now = new Date('2026-11-09T10:00:00Z');
    const res = await createPremiumQuoteRequest(prisma as unknown as P, input, now);
    expect(res.ok).toBe(true);
    const saved = (prisma.premiumQuoteRequest.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(saved.estimate).toMatchObject({ total: 8800, list: 11700, monthly: 298 });
    expect(saved.configVersion).toBe(4);
    expect(saved.consentAt).toEqual(now);
    expect(saved.consentVersion).toBe('2026-11-09');
    expect(saved.ipHash).not.toContain('1.1.1.1');
  });

  it('el campo trampa no guarda nada y responde como si hubiera ido bien', async () => {
    const prisma = mockPrisma(published());
    const res = await createPremiumQuoteRequest(prisma as unknown as P, { ...input, trap: 'http://spam' });
    expect(res).toEqual({ ok: true, saved: null });
    expect(prisma.premiumQuoteRequest.create).not.toHaveBeenCalled();
  });

  it('sin publicar no acepta solicitudes', async () => {
    const prisma = mockPrisma(raw);
    expect(await createPremiumQuoteRequest(prisma as unknown as P, input)).toEqual({ ok: false, error: 'not_available' });
  });

  it('aplica el tope por IP', async () => {
    const prisma = mockPrisma(published(), { ip: MAX_REQUESTS_PER_IP_PER_DAY });
    expect(await createPremiumQuoteRequest(prisma as unknown as P, input)).toEqual({ ok: false, error: 'rate_limited' });
    expect(prisma.premiumQuoteRequest.create).not.toHaveBeenCalled();
  });

  it('rechaza una franja que no está en la lista', async () => {
    const prisma = mockPrisma(published());
    expect(await createPremiumQuoteRequest(prisma as unknown as P, { ...input, franja: 'A las 3' })).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('saveQuoterVersion', () => {
  type P = Parameters<typeof saveQuoterVersion>[0];
  const productRows = CATALOG.products.flatMap((p) => [
    ...p.tiers.map((t) => ({ code: p.code, tier: t.tier, priceCents: t.priceCents, setupFeeCents: t.setupFeeCents, currency: 'eur', selfServeEligible: false, stripeAnnualPriceId: null, kind: 'plan' })),
    ...p.addons.map((a) => ({ code: a.code, tier: 'standard', priceCents: a.priceCents, setupFeeCents: 0, currency: 'eur', selfServeEligible: false, stripeAnnualPriceId: null, kind: 'addon' })),
  ]);
  const prismaWith = (latest: number | null) => ({
    premiumQuoterVersion: { findFirst: vi.fn(async () => (latest === null ? null : { version: latest })), create: vi.fn(async () => ({})) },
    product: { findMany: vi.fn(async () => productRows) },
  });

  it('crea la versión siguiente', async () => {
    const prisma = prismaWith(3);
    expect(await saveQuoterVersion(prisma as unknown as P, { data: raw, basedOn: 3, operatorEmail: 'o@k.es' })).toEqual({ ok: true, version: 4 });
  });

  it('no pisa lo que otro ha guardado mientras tanto', async () => {
    const prisma = prismaWith(5);
    expect(await saveQuoterVersion(prisma as unknown as P, { data: raw, basedOn: 3, operatorEmail: null })).toEqual({ ok: false, error: 'conflict', currentVersion: 5 });
    expect(prisma.premiumQuoterVersion.create).not.toHaveBeenCalled();
  });

  it('no deja guardar una referencia que el catálogo no tiene', async () => {
    const d = JSON.parse(JSON.stringify(raw)) as QuoterData;
    d.baseSteps.find((s) => s.id === 'crecimiento')!.options[0].catalog = { code: 'reviews', tier: 'platino' };
    const res = await saveQuoterVersion(prismaWith(0) as unknown as P, { data: d, basedOn: 0, operatorEmail: null });
    expect(res).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('canMovePremiumQuote', () => {
  it('sigue el vocabulario de los leads', () => {
    expect(canMovePremiumQuote('nuevo', 'contactado')).toBe(true);
    expect(canMovePremiumQuote('contactado', 'convertido')).toBe(true);
    expect(canMovePremiumQuote('convertido', 'contactado')).toBe(true);
    expect(canMovePremiumQuote('convertido', 'descartado')).toBe(false);
    expect(canMovePremiumQuote('nuevo', 'nuevo')).toBe(false);
  });
});
