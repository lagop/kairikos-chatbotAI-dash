// =============================================================================
// Cartera — alta del operador, idempotente (docs/fase1-cartera.md, «Producto y
// acceso»). Las dos vías —POST /api/admin/portal/cartera y «Productos
// contratados»— dejan el módulo igual: la contratación activa y su
// CarteraSite con el token del feed. Llamar dos veces no crea otro sitio;
// reactivar dentro del plazo de gracia anula la baja. Y la configuración del
// operador enseña los tokens una sola vez y guarda solo el hash del secreto.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/recall-onboarding', () => ({ ensureRecallSubscription: vi.fn() }));
vi.mock('@/lib/product-onboarding', () => ({
  ensureSeoProfile: vi.fn(),
  ensureProspectingCampaign: vi.fn(),
  ensureLeadQualificationProfile: vi.fn(),
  ensureConversationDigestSchedule: vi.fn(),
}));
vi.mock('@/lib/client-site', () => ({ assignSiteToNewContract: vi.fn(async () => ({ clientSiteId: 'site_1' })) }));

import type { PrismaClient } from '@prisma/client';
import { activateClientProductForOperator } from '@/lib/client-product-activation';
import { activateCartera, hashBuildSecret, verifyBuildSecret } from '@/lib/cartera/site';
import { applySiteSettings, siteSettingsSchema } from '@/lib/cartera/site-settings';

const PRODUCTS: Record<string, { id: string; code: string; tier: string; isActive: boolean }> = {
  p_cartera: { id: 'p_cartera', code: 'cartera', tier: 'standard', isActive: true },
  p_leads: { id: 'p_leads', code: 'leads', tier: 'standard', isActive: true },
};

/** Una base de datos en memoria con lo justo: contratos y sitios persisten entre llamadas. */
function fakeDb(opts: { contract?: { id: string; status: string }; site?: { id: string; exitNotifiedAt: Date | null; clientProductId: string } } = {}) {
  const contracts: Array<{ id: string; status: string }> = opts.contract ? [{ ...opts.contract }] : [];
  const sites: Array<Record<string, unknown>> = opts.site ? [{ ...opts.site }] : [];
  const calls = {
    siteCreate: [] as Array<Record<string, unknown>>,
    siteUpdate: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
    contractAudit: [] as Array<Record<string, unknown>>,
    contractUpdate: [] as Array<Record<string, unknown>>,
  };
  const db = {
    chatbotClient: { findUnique: vi.fn(async () => ({ id: 'c_1', tenantId: 't_1', companyName: 'Alféizar', name: 'Alféizar' })) },
    product: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => PRODUCTS[where.id] ?? null),
      findFirst: vi.fn(async () => ({ id: 'p_cartera' })),
    },
    clientProduct: {
      // Una copia, como Prisma: el llamante no ve las escrituras posteriores.
      findFirst: vi.fn(async () => (contracts[0] ? { ...contracts[0] } : null)),
      create: vi.fn(async ({ data }: { data: { productId: string } }) => {
        const c = { id: 'cp_new', status: 'active' };
        contracts.push(c);
        return { ...c, tenantId: 't_1', product: PRODUCTS[data.productId] };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.contractUpdate.push(args.data);
        const c = contracts.find((x) => x.id === args.where.id);
        if (c && typeof args.data.status === 'string') c.status = args.data.status;
        return { id: args.where.id, tenantId: 't_1', product: PRODUCTS.p_cartera };
      }),
    },
    clientProductAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => calls.contractAudit.push(data)) },
    carteraSite: {
      findUnique: vi.fn(async ({ where }: { where: { clientProductId: string } }) => sites.find((s) => s.clientProductId === where.clientProductId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.siteCreate.push(data);
        const s = { id: `site_${sites.length + 1}`, exitNotifiedAt: null, ...data };
        sites.push(s);
        return { id: s.id };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.siteUpdate.push(data);
        return {};
      }),
    },
    carteraAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => calls.audit.push(data)) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, calls };
}

describe('POST /api/admin/portal/cartera (activateCartera)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('la primera vez crea contratación y sitio, y enseña el token del feed', async () => {
    const { db, calls } = fakeDb();
    const r = await activateCartera(db as never, { clientId: 'c_1', operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, created: true, clientProductId: 'cp_new' });
    if (!r.ok) throw new Error('esperaba ok');
    expect(r.feedToken).toMatch(/^car_[A-Za-z0-9_-]{10,60}$/);
    expect(calls.siteCreate).toHaveLength(1);
    expect(calls.siteCreate[0]).toMatchObject({ clientProductId: 'cp_new', clientId: 'c_1', tenantId: 't_1', feedToken: r.feedToken });
    expect(calls.contractAudit[0]).toMatchObject({ action: 'cartera_activated', actorId: 'operator:op_1' });
    expect(calls.audit[0]).toMatchObject({ entity: 'site', action: 'created', actor: 'operator:op_1' });
    // La auditoría no lleva el token.
    expect(JSON.stringify(calls.audit)).not.toContain(r.feedToken);
  });

  it('la segunda vez devuelve el mismo sitio, sin crear otro ni volver a enseñar el token', async () => {
    const { db, calls } = fakeDb();
    const first = await activateCartera(db as never, { clientId: 'c_1', operatorId: 'op_1' });
    const second = await activateCartera(db as never, { clientId: 'c_1', operatorId: 'op_1' });

    expect(second).toMatchObject({ ok: true, created: false, feedToken: null });
    if (!first.ok || !second.ok) throw new Error('esperaba ok');
    expect(second.siteId).toBe(first.siteId);
    expect(calls.siteCreate).toHaveLength(1);
    expect(calls.contractAudit).toHaveLength(1);
  });

  it('reactivar una baja dentro del plazo de gracia la anula y no crea otro sitio', async () => {
    const { db, calls } = fakeDb({
      contract: { id: 'cp_old', status: 'cancelled' },
      site: { id: 'site_old', clientProductId: 'cp_old', exitNotifiedAt: new Date('2026-11-10T09:00:00Z') },
    });
    const r = await activateCartera(db as never, { clientId: 'c_1', operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, created: false, siteId: 'site_old' });
    expect(calls.siteCreate).toHaveLength(0);
    expect(calls.siteUpdate).toEqual([{ exitNotifiedAt: null }]);
    expect(calls.contractAudit[0]).toMatchObject({ action: 'cartera_reactivated', statusBefore: 'cancelled' });
  });

  it('sin la fila del producto en el catálogo: product_missing', async () => {
    const { db } = fakeDb();
    db.product.findFirst.mockResolvedValueOnce(null as never);
    expect(await activateCartera(db as never, { clientId: 'c_1', operatorId: 'op_1' })).toEqual({ ok: false, error: 'product_missing' });
  });
});

describe('alta desde «Productos contratados»', () => {
  beforeEach(() => vi.clearAllMocks());

  it('crea el CarteraSite con su token y la deja en marcha', async () => {
    const { db, calls } = fakeDb();
    const r = await activateClientProductForOperator(db as unknown as PrismaClient, { clientId: 'c_1', productId: 'p_cartera' }, { operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, productCode: 'cartera', wasReactivated: false });
    expect(calls.siteCreate).toHaveLength(1);
    expect(String(calls.siteCreate[0].feedToken)).toMatch(/^car_/);
    expect(calls.contractUpdate).toContainEqual({ onboardingState: 'live' });
  });

  it('dos veces seguidas: un solo sitio', async () => {
    const { db, calls } = fakeDb();
    await activateClientProductForOperator(db as unknown as PrismaClient, { clientId: 'c_1', productId: 'p_cartera' }, { operatorId: 'op_1' });
    await activateClientProductForOperator(db as unknown as PrismaClient, { clientId: 'c_1', productId: 'p_cartera' }, { operatorId: 'op_1' });
    expect(calls.siteCreate).toHaveLength(1);
  });

  it('otro producto no toca la cartera', async () => {
    const { db, calls } = fakeDb();
    await activateClientProductForOperator(db as unknown as PrismaClient, { clientId: 'c_1', productId: 'p_leads' }, { operatorId: 'op_1' });
    expect(calls.siteCreate).toHaveLength(0);
    expect(calls.siteUpdate).toHaveLength(0);
  });
});

describe('PATCH /api/admin/portal/cartera/[siteId] (applySiteSettings)', () => {
  const site = { id: 'site_1', clientId: 'c_1', salePrefix: 'C', rentPrefix: 'A' };

  it('regenerar enseña el token y el secreto una vez, y guarda solo el hash del secreto', async () => {
    const { db, calls } = fakeDb();
    const r = await applySiteSettings(db as never, site, { regenerateFeedToken: true, regenerateBuildSecret: true }, 'operator:op_1');

    if (!r.ok) throw new Error('esperaba ok');
    expect(r.feedToken).toMatch(/^car_/);
    expect(r.buildSecret).toMatch(/^cbs_/);
    const saved = calls.siteUpdate[0];
    expect(saved.feedToken).toBe(r.feedToken);
    expect(saved.buildSecretHash).toBe(hashBuildSecret(r.buildSecret!));
    expect(JSON.stringify(saved)).not.toContain(r.buildSecret!);
    expect(verifyBuildSecret(r.buildSecret!, String(saved.buildSecretHash))).toBe(true);
    expect(verifyBuildSecret('cbs_otro', String(saved.buildSecretHash))).toBe(false);

    const audit = JSON.stringify(calls.audit);
    expect(calls.audit.map((a) => a.action)).toEqual(['feed_token_regenerated', 'build_secret_regenerated']);
    expect(audit).not.toContain(r.feedToken!);
    expect(audit).not.toContain(r.buildSecret!);
    expect(audit).not.toContain(String(saved.buildSecretHash));
  });

  it('sin regenerar no devuelve tokens; la auditoría dice qué campos cambiaron', async () => {
    const { db, calls } = fakeDb();
    const input = siteSettingsSchema.parse({
      githubRepo: 'lagop/cliente-x',
      siteUrl: 'https://alfeizar.example.es/',
      agents: [{ key: 'lucia', name: 'Lucía Marín' }],
    });
    const r = await applySiteSettings(db as never, site, input, 'operator:op_1');
    expect(r).toEqual({ ok: true, changed: ['githubRepo', 'siteUrl', 'agents'] });
    expect(calls.siteUpdate[0]).toEqual({ githubRepo: 'lagop/cliente-x', siteUrl: 'https://alfeizar.example.es', agents: [{ key: 'lucia', name: 'Lucía Marín' }] });
    expect(calls.audit[0]).toMatchObject({ action: 'settings_updated', metadata: { fields: ['githubRepo', 'siteUrl', 'agents'] } });
  });

  it('venta y alquiler no pueden compartir prefijo', async () => {
    const { db, calls } = fakeDb();
    expect(await applySiteSettings(db as never, site, { rentPrefix: 'C' }, 'operator:op_1')).toEqual({ ok: false, error: 'same_prefix' });
    expect(calls.siteUpdate).toHaveLength(0);
  });

  it('valida la forma de lo que entra', () => {
    expect(siteSettingsSchema.safeParse({ githubRepo: 'no-es-un-repo' }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ workflowFile: 'publicar.sh' }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ siteUrl: 'ftp://archivos.example' }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ salePrefix: 'c' }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ agents: [{ key: 'lucia', name: 'A' }, { key: 'lucia', name: 'B' }] }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ regenerateFeedToken: false }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ feedToken: 'car_elegido_a_mano' }).success).toBe(false);
  });
});
