// =============================================================================
// Plan de precios del 01/10/2026 — Ficha de Google gestionada
// (lib/gbp-managed.ts y lib/gbp-post-ai.ts).
//
// Lo que no puede fallar en silencio:
//  - publicar sin que haya pasado el plazo del veto, o publicar dos veces;
//  - publicar sola una publicación con un teléfono, un enlace o un correo;
//  - escribir dos borradores la misma semana (cada uno cuesta una llamada);
//  - publicar en una ficha cuya contratación ya no está activa;
//  - que un cliente toque la publicación de otro.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  generateGbpPost: vi.fn(),
  createProductCheckoutSession: vi.fn(),
}));

vi.mock('@/lib/google-business', () => ({
  getValidAccessToken: (...a: unknown[]) => mockState.getValidAccessToken(...a),
}));
vi.mock('@/lib/gbp-post-ai', () => ({
  generateGbpPost: (...a: unknown[]) => mockState.generateGbpPost(...a),
}));
vi.mock('@/lib/stripe-billing', () => ({
  createProductCheckoutSession: (...a: unknown[]) => mockState.createProductCheckoutSession(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import {
  createGbpManagedCheckout,
  editDraft,
  isConnectionManaged,
  publishDraft,
  rejectDraft,
  sweepGbpManagedPosts,
} from '@/lib/gbp-managed';

const NOW = new Date('2026-10-05T10:00:00Z');
const CONN = {
  id: 'conn_1',
  clientId: 'c1',
  tenantId: 't1',
  googleAccountId: 'accounts/111',
  locationId: 'locations/222',
  locationName: 'Fontanería Aurora',
  status: 'active',
  managedClientProductId: 'cp_managed_1',
};

function makePrisma() {
  const db = {
    clientProduct: {
      findFirst: vi.fn().mockResolvedValue({ id: 'cp_managed_1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'cp_managed_1', clientId: 'c1' }]),
    },
    googleBusinessConnection: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        'managedClientProductId' in args.where && (args.where.managedClientProductId as { in?: unknown })?.in
          ? [{ managedClientProductId: 'cp_managed_1' }]
          : [CONN],
      ),
      findFirst: vi.fn().mockResolvedValue(CONN),
      findUnique: vi.fn().mockResolvedValue(CONN),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gbpPost: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    chatbotClient: { findUnique: vi.fn().mockResolvedValue({ name: 'Aurora', companyName: 'Fontanería Aurora' }) },
    seoProfile: { findFirst: vi.fn().mockResolvedValue({ businessDescription: 'Fontanería en Las Palmas.' }) },
    googleReview: { findMany: vi.fn().mockResolvedValue([{ comment: 'Vinieron rápido y lo dejaron todo limpio.' }]) },
    product: { findFirst: vi.fn().mockResolvedValue({ id: 'prod_gbp', stripeRecurringPriceId: 'price_gbp' }) },
  };
  return db;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.getValidAccessToken.mockResolvedValue('tok');
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'accounts/111/locations/222/localPosts/9' }) });
  vi.stubGlobal('fetch', fetchSpy);
});

describe('isConnectionManaged', () => {
  it('sin enlace no está gestionada, y no pregunta a la base de datos', async () => {
    const prisma = makePrisma();
    await expect(isConnectionManaged(prisma as never, { managedClientProductId: null })).resolves.toBe(false);
    expect(prisma.clientProduct.findFirst).not.toHaveBeenCalled();
  });

  it('con enlace a una contratación que ya no está activa, no lo está', async () => {
    const prisma = makePrisma();
    prisma.clientProduct.findFirst.mockResolvedValue(null);
    await expect(isConnectionManaged(prisma as never, { managedClientProductId: 'cp_x' })).resolves.toBe(false);
    expect(prisma.clientProduct.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_x', status: 'active', product: { code: 'gbp_managed' } } }),
    );
  });
});

describe('sweepGbpManagedPosts — el borrador de la semana', () => {
  it('escribe uno con el plazo del veto y no lo publica en la misma pasada', async () => {
    const prisma = makePrisma();
    mockState.generateGbpPost.mockResolvedValue({ ok: true, post: 'Texto de la semana sobre revisar la caldera antes del invierno, sin datos inventados.', risk: null });

    const res = await sweepGbpManagedPosts(prisma as never, NOW);

    expect(res.drafted).toBe(1);
    expect(prisma.gbpPost.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionId: 'conn_1',
        clientProductId: 'cp_managed_1',
        publishAfter: new Date(NOW.getTime() + 48 * 60 * 60_000),
        lastError: null,
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('si ya hay uno de esta semana, no gasta otra llamada al modelo', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findFirst.mockResolvedValue({ id: 'post_semana' });
    await sweepGbpManagedPosts(prisma as never, NOW);
    expect(mockState.generateGbpPost).not.toHaveBeenCalled();
  });

  it('un borrador con un teléfono se guarda retenido', async () => {
    const prisma = makePrisma();
    mockState.generateGbpPost.mockResolvedValue({ ok: true, post: 'Llámanos al 600 000 000 para pedir tu presupuesto de reformas.', risk: 'phone' });
    await sweepGbpManagedPosts(prisma as never, NOW);
    expect(prisma.gbpPost.create).toHaveBeenCalledWith({ data: expect.objectContaining({ lastError: 'held:phone' }) });
  });

  it('no publica uno retenido aunque haya vencido su plazo', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findFirst.mockResolvedValue({ id: 'post_semana' });
    prisma.gbpPost.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.status === 'drafted' ? [{ id: 'p1', lastError: 'held:url' }] : [],
    );
    const res = await sweepGbpManagedPosts(prisma as never, NOW);
    expect(res.published).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('publishDraft', () => {
  const draft = { id: 'p1', status: 'drafted', connectionId: 'conn_1', summary: 'La publicación de la semana.' };

  it('publica en el localPosts de la ficha y lo apunta', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findUnique.mockResolvedValue(draft);

    await expect(publishDraft(prisma as never, 'p1', 'auto', NOW)).resolves.toBe('published');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ languageCode: 'es', summary: 'La publicación de la semana.', topicType: 'STANDARD' });
    expect(prisma.gbpPost.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ status: 'published', publishedBy: 'auto', googlePostName: 'accounts/111/locations/222/localPosts/9' }),
    });
  });

  it('el cron y el botón a la vez: solo uno lo reclama y publica', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findUnique.mockResolvedValue(draft);
    prisma.gbpPost.updateMany.mockResolvedValue({ count: 0 });
    await expect(publishDraft(prisma as never, 'p1', 'auto', NOW)).resolves.toBe('not_publishable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('con la contratación dada de baja no publica nada', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findUnique.mockResolvedValue(draft);
    prisma.clientProduct.findFirst.mockResolvedValue(null);
    await expect(publishDraft(prisma as never, 'p1', 'auto', NOW)).resolves.toBe('not_publishable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('si Google lo rechaza, queda en publish_failed con el error y sin reintentos', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.findUnique.mockResolvedValue(draft);
    fetchSpy.mockResolvedValue({ ok: false, status: 400, text: async () => 'INVALID_ARGUMENT' });
    await expect(publishDraft(prisma as never, 'p1', 'auto', NOW)).resolves.toBe('publish_failed');
    expect(prisma.gbpPost.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'publish_failed', lastError: expect.stringContaining('google_local_posts_error:400') },
    });
  });
});

describe('el veto del cliente', () => {
  it('editar no publica, y solo toca borradores del propio cliente', async () => {
    const prisma = makePrisma();
    await expect(
      editDraft(prisma as never, { postId: 'p1', clientId: 'c1', summary: 'Texto nuevo de la publicación, revisado a mano.' }),
    ).resolves.toBe('ok');
    expect(prisma.gbpPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', clientId: 'c1', status: 'drafted' },
      data: expect.objectContaining({ summary: 'Texto nuevo de la publicación, revisado a mano.', lastError: null }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('un texto editado con un enlace se guarda retenido', async () => {
    const prisma = makePrisma();
    await expect(
      editDraft(prisma as never, { postId: 'p1', clientId: 'c1', summary: 'Mira nuestras ofertas en www.ejemplo.com esta semana.' }),
    ).resolves.toBe('risky');
  });

  it('descartar solo vale sobre un borrador propio', async () => {
    const prisma = makePrisma();
    prisma.gbpPost.updateMany.mockResolvedValue({ count: 0 });
    await expect(rejectDraft(prisma as never, { postId: 'p_ajeno', clientId: 'c1' })).resolves.toBe(false);
  });
});

describe('createGbpManagedCheckout', () => {
  it('con ficha elegida, ata la contratación pendiente a esa ficha', async () => {
    const prisma = makePrisma();
    prisma.clientProduct.findFirst.mockResolvedValue(null); // la ficha no está gestionada
    mockState.createProductCheckoutSession.mockResolvedValue({ ok: true, url: 'https://checkout', clientProductId: 'cp_new' });

    const res = await createGbpManagedCheckout(prisma as never, {
      clientId: 'c1',
      connectionId: 'conn_1',
      billing: 'monthly',
      actorId: 'client:c1',
      returnPath: '/portal/resenas',
    });

    expect(res).toEqual(expect.objectContaining({ ok: true }));
    expect(prisma.googleBusinessConnection.findFirst).toHaveBeenCalledWith({
      where: { id: 'conn_1', clientId: 'c1', status: 'active' },
    });
    expect(prisma.googleBusinessConnection.update).toHaveBeenCalledWith({
      where: { id: 'conn_1' },
      data: { managedClientProductId: 'cp_new' },
    });
  });

  it('una ficha ajena no se encuentra; una ya gestionada no se paga dos veces', async () => {
    const prisma = makePrisma();
    prisma.googleBusinessConnection.findFirst.mockResolvedValueOnce(null);
    await expect(
      createGbpManagedCheckout(prisma as never, { clientId: 'c1', connectionId: 'conn_ajena', billing: 'monthly', actorId: 'a', returnPath: '/portal/resenas' }),
    ).resolves.toEqual({ ok: false, error: 'connection_not_found' });

    await expect(
      createGbpManagedCheckout(prisma as never, { clientId: 'c1', connectionId: 'conn_1', billing: 'monthly', actorId: 'a', returnPath: '/portal/resenas' }),
    ).resolves.toEqual({ ok: false, error: 'already_managed' });
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });
});
