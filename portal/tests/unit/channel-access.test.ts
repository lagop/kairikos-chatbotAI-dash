// =============================================================================
// WP: conexión de canales — unit tests for src/lib/channel-access.ts.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { getAllowedChannelsForClient, isChannelAllowedForClient } from '@/lib/channel-access';

// Fase 4 multi-instancia — la función pide hasta dos contrataciones (findMany
// + take:2) para poder detectar que hay dos chatbots en vez de leer la tarifa
// de uno cualquiera. Con un argumento, un chatbot; con un array, los que sean.
function makePrisma(clientProduct: unknown) {
  const rows = Array.isArray(clientProduct) ? clientProduct : clientProduct ? [clientProduct] : [];
  return {
    clientProduct: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  } as never;
}

describe('getAllowedChannelsForClient', () => {
  it('returns the channels for a starter tier', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web'] } } });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual(['web']);
  });

  it('returns the channels for a pro tier', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web', 'telegram', 'whatsapp'] } } });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual(['web', 'telegram', 'whatsapp']);
  });

  it('returns the channels for a premium tier', async () => {
    const prisma = makePrisma({
      product: { features: { channels: ['web', 'telegram', 'whatsapp', 'messenger', 'instagram'] } },
    });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual([
      'web',
      'telegram',
      'whatsapp',
      'messenger',
      'instagram',
    ]);
  });

  it('returns an empty array when the client has no active chatbot ClientProduct', async () => {
    const prisma = makePrisma(null);
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual([]);
  });

  it('fails closed when features is missing channels', async () => {
    const prisma = makePrisma({ product: { features: {} } });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual([]);
  });

  it('fails closed when features is not an object', async () => {
    const prisma = makePrisma({ product: { features: null } });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual([]);
  });

  it('drops unknown channel codes rather than trusting arbitrary catalog data', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web', 'carrier-pigeon'] } } });
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual(['web']);
  });

  it('scopes the query by clientId, status=active, and product.code=chatbot', async () => {
    const prisma = makePrisma(null);
    await getAllowedChannelsForClient(prisma, 'c1');
    expect(prisma.clientProduct.findMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', status: 'active', product: { code: 'chatbot' } },
      select: { product: { select: { features: true } } },
      orderBy: { subscribedAt: 'asc' },
      take: 2,
    });
  });

  // ---------------------------------------------------------------------------
  // Fase 4 multi-instancia — el fallo de plan que esto cierra. Antes era un
  // findFirst sin orden: con un Starter (solo web) y un Premium (con WhatsApp)
  // podía leer la tarifa del Premium y dejar conectar WhatsApp al Starter.
  // ---------------------------------------------------------------------------
  const STARTER = { product: { features: { channels: ['web'] } } };
  const PREMIUM = { product: { features: { channels: ['web', 'whatsapp'] } } };

  it('con dos chatbots y sin decir cuál, NO concede ningún canal', async () => {
    const prisma = makePrisma([STARTER, PREMIUM]);
    await expect(getAllowedChannelsForClient(prisma, 'c1')).resolves.toEqual([]);
  });

  it('con el chatbot indicado, fija la consulta a esa contratación', async () => {
    const prisma = makePrisma(STARTER);
    await expect(getAllowedChannelsForClient(prisma, 'c1', 'cp_starter')).resolves.toEqual(['web']);
    expect(prisma.clientProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cp_starter', clientId: 'c1', status: 'active', product: { code: 'chatbot' } },
      }),
    );
  });
});

describe('isChannelAllowedForClient', () => {
  it('returns true when the channel is in the allowed list', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web', 'telegram'] } } });
    await expect(isChannelAllowedForClient(prisma, 'c1', 'telegram')).resolves.toBe(true);
  });

  it('returns false when the channel is not in the allowed list', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web'] } } });
    await expect(isChannelAllowedForClient(prisma, 'c1', 'whatsapp')).resolves.toBe(false);
  });

  it('pasa el chatbot hasta la consulta: la tarifa que cuenta es la de ése', async () => {
    const prisma = makePrisma({ product: { features: { channels: ['web'] } } });
    await expect(isChannelAllowedForClient(prisma, 'c1', 'whatsapp', 'cp_starter')).resolves.toBe(false);
    expect(prisma.clientProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cp_starter' }) }),
    );
  });
});
