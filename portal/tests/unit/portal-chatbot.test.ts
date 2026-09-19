// =============================================================================
// Fase 4 multi-instancia — de qué chatbot habla una pantalla del portal.
//
// Lo que importa: con un chatbot nada cambia (ni selector ni parámetro en las
// llamadas), y con varios la pantalla nunca se queda sin chatbot ni acepta
// uno que no sea del cliente.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { resolvePortalChatbot, chatbotParamFor } from '@/lib/portal-chatbot';

const row = (id: string, name: string | null) => ({
  id,
  product: { tier: 'pro' },
  clientSite: name === null ? null : { name },
});

function makePrisma(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { prisma: { clientProduct: { findMany } } as never, findMany };
}

describe('resolvePortalChatbot', () => {
  it('solo mira los chatbots activos de ESTE cliente, en orden de alta', async () => {
    const { prisma, findMany } = makePrisma([]);
    await resolvePortalChatbot(prisma, 'c1', null);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'c1', status: 'active', product: { code: 'chatbot' } },
        orderBy: { subscribedAt: 'asc' },
      }),
    );
  });

  it('con un chatbot: ese, y sin parámetro en las llamadas', async () => {
    const { prisma } = makePrisma([row('cp_a', 'Clínica Orly')]);
    const selection = await resolvePortalChatbot(prisma, 'c1', null);
    expect(selection.selected).toEqual({ clientProductId: 'cp_a', tier: 'pro', name: 'Clínica Orly' });
    expect(chatbotParamFor(selection)).toBeNull();
  });

  it('con varios y el id en la URL: ese, y las llamadas lo llevan', async () => {
    const { prisma } = makePrisma([row('cp_a', 'Centro'), row('cp_b', 'Norte')]);
    const selection = await resolvePortalChatbot(prisma, 'c1', 'cp_b');
    expect(selection.selected?.clientProductId).toBe('cp_b');
    expect(chatbotParamFor(selection)).toBe('cp_b');
  });

  it('con varios sin id, o con un id que no es suyo: el primero, nunca otro cliente', async () => {
    const { prisma } = makePrisma([row('cp_a', 'Centro'), row('cp_b', 'Norte')]);
    expect((await resolvePortalChatbot(prisma, 'c1', null)).selected?.clientProductId).toBe('cp_a');
    expect((await resolvePortalChatbot(prisma, 'c1', 'cp_ajeno')).selected?.clientProductId).toBe('cp_a');
  });

  it('sin nombre de negocio, "Chatbot N"', async () => {
    const { prisma } = makePrisma([row('cp_a', null), row('cp_b', '  ')]);
    const { chatbots } = await resolvePortalChatbot(prisma, 'c1', null);
    expect(chatbots.map((c) => c.name)).toEqual(['Chatbot 1', 'Chatbot 2']);
  });

  it('sin chatbots: nada seleccionado', async () => {
    const { prisma } = makePrisma([]);
    const selection = await resolvePortalChatbot(prisma, 'c1', 'cp_a');
    expect(selection.selected).toBeNull();
    expect(chatbotParamFor(selection)).toBeNull();
  });
});
