// =============================================================================
// WP: conexión de canales — unit tests for src/lib/channel-access.ts.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { getAllowedChannelsForClient, isChannelAllowedForClient } from '@/lib/channel-access';

function makePrisma(clientProduct: unknown) {
  return {
    clientProduct: {
      findFirst: vi.fn().mockResolvedValue(clientProduct),
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
    expect(prisma.clientProduct.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'c1', status: 'active', product: { code: 'chatbot' } },
      select: { product: { select: { features: true } } },
    });
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
});
