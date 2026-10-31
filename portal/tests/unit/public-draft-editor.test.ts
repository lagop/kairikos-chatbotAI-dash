import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { savePublicDraftContent, servePublicDraftReview } from '@/lib/public-draft-editor';
import { DRAFT_HUELLA_SQL } from '@/lib/web-draft-edit';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

// 30/10/2026 — el borrador de kairikos.com, retocado por el operador antes de
// enviárselo (lib/public-draft-editor.ts).

const ID = '33333333-3333-4333-8333-333333333333';
const HUELLA = 'a'.repeat(32);
const content = () => structuredClone(SITE_CONTENT_SAMPLES.normal);

function fakePrisma(locked: Array<{ template_id: string | null }>, exists = true) {
  const sql: string[] = [];
  const update = vi.fn();
  const versions: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async (q: Prisma.Sql) => {
      sql.push(q.sql);
      return /FOR UPDATE/.test(q.sql) ? locked : [{ huella: 'b'.repeat(32) }];
    }),
    publicDraftRequest: {
      findUnique: vi.fn(async () => (exists ? { id: ID } : null)),
      findUniqueOrThrow: vi.fn(async () => ({ copy: { headline: 'antes' }, content: { v: 'antes' }, templateId: 'tpl', themeKey: 'trades-1' })),
      update,
    },
    publicDraftVersion: { create: vi.fn(async (a: { data: unknown }) => versions.push(a.data)) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
  return { prisma, sql, update, versions };
}

describe('guardar un borrador de kairikos.com', () => {
  it('guarda solo el contenido, bloqueando la fila con la misma huella que los de prospección', async () => {
    const { prisma, sql, update } = fakePrisma([{ template_id: 'tpl' }]);
    const r = await savePublicDraftContent(prisma, ID, { content: content(), baseUpdatedAt: HUELLA }, 'op-1');
    expect(r).toEqual({ status: 200, body: { ok: true, updatedAt: 'b'.repeat(32) } });
    expect(Object.keys(update.mock.calls[0][0].data)).toEqual(['content']);
    expect(sql[0]).toContain('"PublicDraftRequest"');
    expect(sql[0]).toContain(DRAFT_HUELLA_SQL);
    expect(sql[0]).toContain('FOR UPDATE');
  });

  it('deja lo que había en el historial antes de guardar (31/10)', async () => {
    const { prisma, versions } = fakePrisma([{ template_id: 'tpl' }]);
    await savePublicDraftContent(prisma, ID, { content: content(), baseUpdatedAt: HUELLA }, 'op-1');
    expect(versions).toEqual([
      expect.objectContaining({ requestId: ID, accion: 'editado', actorId: 'op-1', content: { v: 'antes' }, templateId: 'tpl', themeKey: 'trades-1' }),
    ]);
  });

  it('si cambió mientras estaba abierto, o es del diseño antiguo, no guarda', async () => {
    const stale = fakePrisma([]);
    expect(await savePublicDraftContent(stale.prisma, ID, { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).toEqual({ status: 409, body: { error: 'stale_draft' } });
    const old = fakePrisma([{ template_id: null }]);
    expect(await savePublicDraftContent(old.prisma, ID, { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).toEqual({ status: 409, body: { error: 'old_design' } });
    expect(stale.update).not.toHaveBeenCalled();
    expect(old.update).not.toHaveBeenCalled();
    expect(stale.versions).toEqual([]);
    expect(old.versions).toEqual([]);
  });
});

describe('revisarlo antes de enviarlo', () => {
  it('sin escribir todavía lo dice, en vez de enseñar una página vacía', async () => {
    const prisma = { publicDraftRequest: { findUnique: vi.fn(async () => ({ token: 't', copy: null })) } } as unknown as PrismaClient;
    const res = await servePublicDraftReview(prisma, ID, 'https://portal.example');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Todavía no está escrito');
  });
});
