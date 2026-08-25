// =============================================================================
// WP-XX — the billing settings page must list INACTIVE products too.
//
// It used to filter `where: { isActive: true }`, which made the only safe
// order impossible: a product needs Stripe prices before a client can buy
// it, but it had to be on sale to appear on the page that creates them.
// The operator was forced to expose a product to clients in order to be
// allowed to give it prices — with a window in between where the checkout
// returns 502 because the price id is still a placeholder.
//
// This is the first test in the repo to import a page component. It only
// became possible once vitest was told to transform JSX (see
// vitest.config.ts): tsconfig sets `jsx: 'preserve'` for Next's benefit,
// and esbuild was honouring it.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  getSession: vi.fn(),
  getStripeCredentialStatus: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { product: { findMany: (...a: unknown[]) => mockState.productFindMany(...a) } },
}));
vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockState.getSession(...a) }));
vi.mock('@/lib/stripe-credentials', () => ({
  getStripeCredentialStatus: (...a: unknown[]) => mockState.getStripeCredentialStatus(...a),
}));
vi.mock('next/navigation', () => ({
  redirect: (...a: unknown[]) => {
    mockState.redirect(...a);
    // The real redirect() throws to unwind the render; mirror that so the
    // code after it is genuinely unreachable here too.
    throw new Error('NEXT_REDIRECT');
  },
}));

async function render() {
  const mod = await import('@/app/admin/portal/settings/billing/page');
  return mod.default();
}

/** The panel receives the products as a prop; dig it out of the returned
 *  element tree rather than asserting on markup. */
function panelProducts(tree: unknown): Array<Record<string, unknown>> | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown): Array<Record<string, unknown>> | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const el = node as { props?: Record<string, unknown> };
    const products = el.props?.initialProducts;
    if (Array.isArray(products)) return products as Array<Record<string, unknown>>;
    for (const value of Object.values(el.props ?? {})) {
      const found = Array.isArray(value)
        ? value.map(walk).find(Boolean) ?? null
        : walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(tree);
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.getSession.mockResolvedValue({ isOperator: true });
  mockState.getStripeCredentialStatus.mockResolvedValue({ activeMode: null });
  mockState.productFindMany.mockResolvedValue([]);
});

describe('/admin/portal/settings/billing — the catalogue query', () => {
  it('does not filter by isActive', async () => {
    await render();
    // The whole point: a product that is not on sale yet is exactly the
    // one that still needs its Stripe prices created.
    expect(mockState.productFindMany.mock.calls[0][0].where).toBeUndefined();
  });

  it('selects isActive, so a row can say it is not on sale', async () => {
    await render();
    expect(mockState.productFindMany.mock.calls[0][0].select.isActive).toBe(true);
  });

  it('puts the products already on sale first', async () => {
    await render();
    // Inactive rows are the exception; they must not push the everyday
    // ones down the page.
    expect(mockState.productFindMany.mock.calls[0][0].orderBy[0]).toEqual({ isActive: 'desc' });
  });

  it('still refuses a non-operator, before reading anything', async () => {
    mockState.getSession.mockResolvedValue({ isOperator: false });
    await expect(render()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockState.redirect).toHaveBeenCalledWith('/portal/login?next=/admin/portal/settings/billing');
    expect(mockState.productFindMany).not.toHaveBeenCalled();
  });
});

describe('/admin/portal/settings/billing — what reaches the panel', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    code: 'recall',
    tier: 'solo',
    name: 'Recuperación de llamadas — Autónomo',
    isActive: false,
    priceCents: 14900,
    setupFeeCents: 29000,
    currency: 'EUR',
    stripeProductId: null,
    stripeRecurringPriceId: 'price_recall_solo',
    stripeSetupPriceId: 'price_recall_solo_setup',
    stripePriceMode: null,
    ...over,
  });

  it('passes an inactive product through, flag intact', async () => {
    mockState.productFindMany.mockResolvedValue([row()]);
    const products = panelProducts(await render());
    expect(products).toHaveLength(1);
    expect(products?.[0]).toMatchObject({ code: 'recall', isActive: false });
  });

  it('narrows a stray stripePriceMode to null rather than passing it on', async () => {
    mockState.productFindMany.mockResolvedValue([row({ stripePriceMode: 'sandbox' })]);
    const products = panelProducts(await render());
    // The column is free-form; only 'test' and 'live' mean anything to
    // the panel, and an unknown value must not be rendered as a mode.
    expect(products?.[0].stripePriceMode).toBeNull();
  });

  it('keeps a real mode', async () => {
    mockState.productFindMany.mockResolvedValue([row({ stripePriceMode: 'live' })]);
    const products = panelProducts(await render());
    expect(products?.[0].stripePriceMode).toBe('live');
  });
});
