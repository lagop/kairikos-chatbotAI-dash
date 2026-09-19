// =============================================================================
// Fase 4 multi-instancia — lib/client-site.ts.
//
// Lo que importa: la primera contratación cuelga del sitio primario (así un
// cliente de un solo negocio no nota nada), la segunda de un producto
// multi-instancia recibe su propio negocio, y reactivar no mueve nada de sitio.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  ensurePrimaryClientSite,
  assignSiteToNewContract,
  syncSiteFromWizardIdentity,
} from '@/lib/client-site';

function makeDb(opts: {
  contractSiteId?: string | null;
  primaryId?: string | null;
  siblings?: number;
  step?: Record<string, unknown> | null;
} = {}) {
  const db = {
    clientProduct: {
      findUnique: vi.fn().mockResolvedValue({ clientSiteId: opts.contractSiteId ?? null }),
      count: vi.fn().mockResolvedValue(opts.siblings ?? 0),
      update: vi.fn().mockResolvedValue({}),
    },
    chatbotClient: {
      findUnique: vi.fn().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Ana' }),
    },
    clientSite: {
      findFirst: vi.fn().mockResolvedValue(opts.primaryId ? { id: opts.primaryId } : null),
      create: vi.fn().mockResolvedValue({ id: 'site_new' }),
      update: vi.fn().mockResolvedValue({}),
    },
    chatbotConfigStep: {
      findUnique: vi.fn().mockResolvedValue(opts.step ?? null),
    },
  };
  return db;
}

const contract = { clientId: 'c1', tenantId: 't1', clientProductId: 'cp2' };

describe('ensurePrimaryClientSite', () => {
  it('devuelve el primario existente sin crear otro', async () => {
    const db = makeDb({ primaryId: 'site_p' });
    await expect(ensurePrimaryClientSite(db as never, { clientId: 'c1', tenantId: 't1', name: 'X' }))
      .resolves.toEqual({ id: 'site_p' });
    expect(db.clientSite.create).not.toHaveBeenCalled();
  });

  it('crea el primario si falta, con nombre de respaldo si llega vacío', async () => {
    const db = makeDb();
    await ensurePrimaryClientSite(db as never, { clientId: 'c1', tenantId: 't1', name: '  ' });
    expect(db.clientSite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPrimary: true, name: 'Mi negocio', siteUrl: null }) }),
    );
  });
});

describe('assignSiteToNewContract', () => {
  it('no mueve una contratación que ya tiene sitio (reactivar)', async () => {
    const db = makeDb({ contractSiteId: 'site_old' });
    await expect(assignSiteToNewContract(db as never, { ...contract, productCode: 'chatbot' }))
      .resolves.toEqual({ clientSiteId: 'site_old' });
    expect(db.clientProduct.update).not.toHaveBeenCalled();
    expect(db.clientSite.create).not.toHaveBeenCalled();
  });

  it('primera contratación de un multi-instancia → el primario', async () => {
    const db = makeDb({ primaryId: 'site_p', siblings: 0 });
    await expect(assignSiteToNewContract(db as never, { ...contract, productCode: 'chatbot' }))
      .resolves.toEqual({ clientSiteId: 'site_p' });
    expect(db.clientSite.create).not.toHaveBeenCalled();
    expect(db.clientProduct.update).toHaveBeenCalledWith({ where: { id: 'cp2' }, data: { clientSiteId: 'site_p' } });
  });

  it('segunda de un multi-instancia → un negocio nuevo con nombre provisional numerado', async () => {
    const db = makeDb({ primaryId: 'site_p', siblings: 1 });
    await expect(assignSiteToNewContract(db as never, { ...contract, productCode: 'chatbot' }))
      .resolves.toEqual({ clientSiteId: 'site_new' });
    expect(db.clientSite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Clínica Orly (2)', isPrimary: false }) }),
    );
  });

  it('las hermanas canceladas o pendientes de pago no cuentan', async () => {
    const db = makeDb({ primaryId: 'site_p' });
    await assignSiteToNewContract(db as never, { ...contract, productCode: 'seo' });
    expect(db.clientProduct.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { not: 'cp2' },
        status: { notIn: ['cancelled', 'pending_payment'] },
        product: { code: 'seo' },
      }),
    });
  });

  it('un producto de un solo contrato → siempre el primario, sin contar hermanas', async () => {
    const db = makeDb({ primaryId: 'site_p', siblings: 3 });
    await expect(assignSiteToNewContract(db as never, { ...contract, productCode: 'reviews' }))
      .resolves.toEqual({ clientSiteId: 'site_p' });
    expect(db.clientProduct.count).not.toHaveBeenCalled();
  });

  it('crea el primario de paso si el cliente no lo tenía', async () => {
    const db = makeDb({ primaryId: null, siblings: 0 });
    db.clientSite.create.mockResolvedValueOnce({ id: 'site_p_new' });
    await expect(assignSiteToNewContract(db as never, { ...contract, productCode: 'chatbot' }))
      .resolves.toEqual({ clientSiteId: 'site_p_new' });
    expect(db.clientSite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPrimary: true, name: 'Clínica Orly' }) }),
    );
  });
});

describe('syncSiteFromWizardIdentity', () => {
  const step1 = {
    stepKey: '1',
    productCode: 'chatbot',
    clientProductId: 'cp2',
    clientId: 'c1',
    payload: { nombre_comercial: ' Orly Dental ', web: 'https://orly.example' },
  };

  it('el paso 1 aprobado renombra el negocio de SU chatbot', async () => {
    const db = makeDb({ contractSiteId: 'site_2', step: step1 });
    await syncSiteFromWizardIdentity(db as never, { stepId: 's1' });
    expect(db.clientProduct.findUnique).toHaveBeenCalledWith({ where: { id: 'cp2' }, select: { clientSiteId: true } });
    expect(db.clientSite.update).toHaveBeenCalledWith({
      where: { id: 'site_2' },
      data: { name: 'Orly Dental', siteUrl: 'https://orly.example' },
    });
  });

  it('otros pasos no tocan el sitio', async () => {
    const db = makeDb({ contractSiteId: 'site_2', step: { ...step1, stepKey: '2' } });
    await syncSiteFromWizardIdentity(db as never, { stepId: 's2' });
    expect(db.clientSite.update).not.toHaveBeenCalled();
  });

  it('sin web no borra la que hubiera', async () => {
    const db = makeDb({ contractSiteId: 'site_2', step: { ...step1, payload: { nombre_comercial: 'Orly' } } });
    await syncSiteFromWizardIdentity(db as never, { stepId: 's1' });
    expect(db.clientSite.update).toHaveBeenCalledWith({ where: { id: 'site_2' }, data: { name: 'Orly' } });
  });

  it('nunca lanza: un fallo se registra y la aprobación sigue', async () => {
    const db = makeDb({ contractSiteId: 'site_2', step: step1 });
    db.clientSite.update.mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(syncSiteFromWizardIdentity(db as never, { stepId: 's1' })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
