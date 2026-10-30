// =============================================================================
// 25/10/2026 — comprar la web desde su borrador (lib/web-self-serve.ts).
//
// Lo que se fija aquí es la regla de negocio, no Stripe: cuándo hay hueco en
// el tope del mes, qué borradores dan derecho a comprar y qué botón enseña la
// página. Prisma va mockeado: que la consulta cuente lo que dice contar se
// comprueba contra el Postgres real, no aquí.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  webSelfServeCapacity,
  startOfMonthUtc,
  formatEurosLabel,
  purchaseCtaFor,
  resolveWebDraft,
  getWebDraftPurchase,
  webDraftPurchasePath,
  DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP,
} from '@/lib/web-self-serve';
import { renderWebDraftHtml } from '@/lib/web-draft-html';

const TOKEN = 'b'.repeat(64);
const NOW = new Date('2026-10-25T12:00:00Z');
const COPY = { headline: 'Tu fontanero', subheadline: '', about: '', services: [], callToAction: '' };

function prismaWith(overrides: {
  publicDraft?: unknown;
  prospectingDraft?: unknown;
  product?: unknown;
  settings?: unknown;
  sold?: number;
  pending?: number;
}): PrismaClient {
  return {
    publicDraftRequest: { findUnique: vi.fn().mockResolvedValue(overrides.publicDraft ?? null) },
    prospectingWebDraft: { findUnique: vi.fn().mockResolvedValue(overrides.prospectingDraft ?? null) },
    product: { findFirst: vi.fn().mockResolvedValue(overrides.product ?? null) },
    webSalesSettings: { findUnique: vi.fn().mockResolvedValue(overrides.settings ?? null) },
    clientProductAudit: { count: vi.fn().mockResolvedValue(overrides.sold ?? 0) },
    clientProduct: { count: vi.fn().mockResolvedValue(overrides.pending ?? 0) },
  } as unknown as PrismaClient;
}

const PUBLIC_DRAFT = {
  businessName: 'Fontanería Pérez',
  city: 'Las Palmas',
  contact: '+34 600 11 22 33',
  primaryType: 'plumber',
  themeKey: 'trades-2',
  copy: COPY,
  phone: null,
  sentAt: new Date('2026-10-25T10:00:00Z'),
};
const WEB_PRODUCT = { id: 'p-web', setupFeeCents: 79900, currency: 'eur', stripeSetupPriceId: 'price_web' };

describe('webSelfServeCapacity', () => {
  it('con el tope por defecto, la cuarta web aún cabe y la quinta no', () => {
    expect(DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP).toBe(4);
    expect(webSelfServeCapacity(4, { sold: 3, pending: 0 })).toEqual({ available: true, remaining: 1 });
    expect(webSelfServeCapacity(4, { sold: 4, pending: 0 }).available).toBe(false);
  });

  it('un pago abierto ocupa hueco: cinco personas a la vez no se llevan una sola web libre', () => {
    expect(webSelfServeCapacity(4, { sold: 3, pending: 1 }).available).toBe(false);
  });

  it('0 apaga la compra desde el borrador', () => {
    expect(webSelfServeCapacity(0, { sold: 0, pending: 0 }).available).toBe(false);
  });
});

describe('startOfMonthUtc', () => {
  it('es el día 1 a las 00:00 UTC', () => {
    expect(startOfMonthUtc(NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('formatEurosLabel', () => {
  it('escribe el precio como en España, sin decimales vacíos', () => {
    expect(formatEurosLabel(79900)).toBe('799 €');
    expect(formatEurosLabel(2950)).toBe('29,50 €');
  });
});

describe('resolveWebDraft', () => {
  it('rechaza un testigo con mala forma sin ir a la base de datos', async () => {
    const prisma = prismaWith({ publicDraft: PUBLIC_DRAFT });
    expect(await resolveWebDraft(prisma, 'no-es-un-testigo')).toBeNull();
    expect(prisma.publicDraftRequest.findUnique).not.toHaveBeenCalled();
  });

  it('un borrador pedido en kairikos.com da derecho a comprar; el contacto solo es teléfono si lo es', async () => {
    const seed = await resolveWebDraft(prismaWith({ publicDraft: PUBLIC_DRAFT }), TOKEN);
    expect(seed).toMatchObject({ kind: 'public', businessName: 'Fontanería Pérez', phone: '+34 600 11 22 33' });
    const byEmail = await resolveWebDraft(prismaWith({ publicDraft: { ...PUBLIC_DRAFT, contact: 'a@b.es' } }), TOKEN);
    expect(byEmail?.phone).toBeNull();
    // 30/10/2026 — el teléfono que deja aparte del correo.
    const withPhone = await resolveWebDraft(prismaWith({ publicDraft: { ...PUBLIC_DRAFT, contact: 'a@b.es', phone: '600 11 22 33' } }), TOKEN);
    expect(withPhone?.phone).toBe('600 11 22 33');
  });

  // 30/10/2026 — hasta que se le envía, su enlace dice «la estamos
  // preparando» (public-draft-delivery.ts): no hay nada que comprar.
  it('un borrador de kairikos.com sin enviar, o sin escribir, no se puede comprar', async () => {
    expect(await resolveWebDraft(prismaWith({ publicDraft: { ...PUBLIC_DRAFT, sentAt: null } }), TOKEN)).toBeNull();
    expect(await resolveWebDraft(prismaWith({ publicDraft: { ...PUBLIC_DRAFT, copy: null } }), TOKEN)).toBeNull();
  });

  it('un borrador de prospección solo si el prospecto es de una cuenta interna', async () => {
    const draft = (isInternal: boolean) => ({
      copy: COPY,
      themeKey: 'trades-1',
      client: { isInternal },
      lead: {
        contactName: 'Reformas Gil',
        contactPhone: '+34928000000',
        summary: 'Negocio encontrado en Calle Mayor 1.',
        primaryType: 'general_contractor',
        searchLocation: 'Las Palmas',
      },
    });
    const ours = await resolveWebDraft(prismaWith({ prospectingDraft: draft(true) }), TOKEN);
    expect(ours).toMatchObject({ kind: 'prospecting', businessName: 'Reformas Gil', address: 'Calle Mayor 1' });
    // El barrido también genera borradores para prospectos de campañas de
    // clientes: venderles una web nuestra no es algo que ese cliente pidiera.
    expect(await resolveWebDraft(prismaWith({ prospectingDraft: draft(false) }), TOKEN)).toBeNull();
  });
});

describe('getWebDraftPurchase', () => {
  it('disponible con borrador, precio en Stripe y hueco', async () => {
    const purchase = await getWebDraftPurchase(
      prismaWith({ publicDraft: PUBLIC_DRAFT, product: WEB_PRODUCT, sold: 1 }),
      TOKEN,
      NOW,
    );
    expect(purchase).toMatchObject({ available: true, product: { setupFeeCents: 79900 } });
  });

  it('sin precio de alta en Stripe no se ofrece: mejor una llamada que un pago que falla', async () => {
    const purchase = await getWebDraftPurchase(
      prismaWith({ publicDraft: PUBLIC_DRAFT, product: { ...WEB_PRODUCT, stripeSetupPriceId: null } }),
      TOKEN,
      NOW,
    );
    expect(purchase).toEqual({ available: false, reason: 'product_unavailable' });
  });

  it('el tope guardado por el operador manda sobre el de por defecto', async () => {
    const purchase = await getWebDraftPurchase(
      prismaWith({ publicDraft: PUBLIC_DRAFT, product: WEB_PRODUCT, settings: { selfServeMonthlyCap: 2 }, sold: 2 }),
      TOKEN,
      NOW,
    );
    expect(purchase).toEqual({ available: false, reason: 'sold_out' });
  });
});

describe('purchaseCtaFor y la página del borrador', () => {
  const DEMO = 'https://cal.com/demo';

  it('con hueco: «La quiero» con el precio del catálogo, hacia /empezar con el borrador', () => {
    const { cta, offer } = purchaseCtaFor(
      { available: true, product: { id: 'p', setupFeeCents: 79900, currency: 'eur' }, seed: {} as never },
      TOKEN,
      DEMO,
    );
    expect(cta).toEqual({ kind: 'buy', href: webDraftPurchasePath(TOKEN), priceLabel: '799 €' });
    expect(cta && cta.href).toBe(`/empezar?producto=web&borrador=${TOKEN}`);
    expect(offer?.priceLabel).toBe('799 €, pago único');
  });

  it('con el tope lleno: reservar una llamada', () => {
    expect(purchaseCtaFor({ available: false, reason: 'sold_out' }, TOKEN, DEMO).cta).toEqual({ kind: 'call', href: DEMO });
  });

  it('con cualquier otro motivo, la página queda como estaba', () => {
    expect(purchaseCtaFor({ available: false, reason: 'draft_not_found' }, TOKEN, DEMO).cta).toBeNull();
    expect(purchaseCtaFor(null, TOKEN, DEMO).cta).toBeNull();
  });

  it('el botón sale en el borrador, y no en el sitio publicado', () => {
    const base = {
      subject: {
        businessName: 'Fontanería Pérez',
        primaryType: 'plumber',
        city: 'Las Palmas',
        address: null,
        phone: null,
        rating: null,
        reviewCount: null,
      },
      copy: COPY,
      generatedAt: NOW,
    };
    const { cta, offer } = purchaseCtaFor(
      { available: true, product: { id: 'p', setupFeeCents: 79900, currency: 'eur' }, seed: {} as never },
      TOKEN,
      DEMO,
    );
    const draft = renderWebDraftHtml({ ...base, purchase: cta, offer });
    expect(draft).toContain('La quiero · 799 €');
    expect(draft).toContain(`href="/empezar?producto=web&amp;borrador=${TOKEN}"`);
    expect(draft).toContain('unos días después de que des el visto bueno');
    // El precio de la nota del pie es el del catálogo, no los «490 €» de antes.
    expect(draft).not.toContain('490 €');
    expect(renderWebDraftHtml(base)).not.toContain('La quiero');
  });
});
