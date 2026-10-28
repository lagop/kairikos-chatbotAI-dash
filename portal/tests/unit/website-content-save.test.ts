import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { saveWebsiteContent } from '@/lib/website-content-save';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

// 28/10/2026 — el cliente y el operador guardan con la misma función; solo
// cambia quién firma en la auditoría.

function fakePrisma(updated = 1) {
  const audits: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  const tx = {
    clientWebsite: { updateMany: vi.fn(async (args: Record<string, unknown>) => (writes.push(args), { count: updated })) },
    clientWebsiteAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), data)) },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { prisma: prisma as unknown as PrismaClient, audits, writes };
}

const website = { id: 'w1', clientId: 'c1', tenantId: null, content: SITE_CONTENT_SAMPLES.normal };
const logo = 'assets/subidas/0123456789abcdef01.png';

describe('saveWebsiteContent', () => {
  it('el operador guarda igual que el cliente y firma él en la auditoría', async () => {
    const { prisma, audits } = fakePrisma();
    const content = { ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo, portada: '' } };
    const r = await saveWebsiteContent(prisma, website, { content }, { type: 'operator', operatorId: 'op1', email: 'op@kairikos.com' });
    expect(r.status).toBe(200);
    expect(audits[0]).toMatchObject({ clientId: 'c1', action: 'content_updated', actorType: 'operator', actorOperatorId: 'op1', actorEmail: 'op@kairikos.com' });
    expect((audits[0].after as { imagenes: unknown }).imagenes).toEqual({ logo, portada: '' });
  });

  it('el cliente firma como client:<id>', async () => {
    const { prisma, audits } = fakePrisma();
    await saveWebsiteContent(prisma, website, { content: SITE_CONTENT_SAMPLES.normal }, { type: 'client', clientId: 'c1' });
    expect(audits[0]).toMatchObject({ actorType: 'client', actorEmail: 'client:c1' });
    expect(audits[0]).not.toHaveProperty('actorOperatorId');
  });

  it('si otro guardó entre medias (cliente y operador a la vez), no pisa nada', async () => {
    const { prisma, audits } = fakePrisma(0);
    const r = await saveWebsiteContent(prisma, website, { content: SITE_CONTENT_SAMPLES.normal, baseUpdatedAt: '2026-10-28T10:00:00.000Z' }, { type: 'operator', operatorId: 'op1', email: null });
    expect(r).toEqual({ status: 409, body: { error: 'stale_content' } });
    expect(audits).toHaveLength(0);
  });

  it('una web sin contenido v2 o un contenido inválido no se guardan', async () => {
    const { prisma } = fakePrisma();
    expect((await saveWebsiteContent(prisma, { ...website, content: null }, { content: SITE_CONTENT_SAMPLES.normal }, { type: 'client', clientId: 'c1' })).body).toEqual({ error: 'not_v2' });
    const bad = await saveWebsiteContent(prisma, website, { content: { ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo: 'https://otra.com/x.png', portada: '' } } }, { type: 'client', clientId: 'c1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_content');
  });
});
