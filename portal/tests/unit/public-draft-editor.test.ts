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
  const tx = {
    $queryRaw: vi.fn(async (q: Prisma.Sql) => {
      sql.push(q.sql);
      return /FOR UPDATE/.test(q.sql) ? locked : [{ huella: 'b'.repeat(32) }];
    }),
    publicDraftRequest: { findUnique: vi.fn(async () => (exists ? { id: ID } : null)), update },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
  return { prisma, sql, update };
}

describe('guardar un borrador de kairikos.com', () => {
  it('guarda solo el contenido, bloqueando la fila con la misma huella que los de prospección', async () => {
    const { prisma, sql, update } = fakePrisma([{ template_id: 'tpl' }]);
    const r = await savePublicDraftContent(prisma, ID, { content: content(), baseUpdatedAt: HUELLA });
    expect(r).toEqual({ status: 200, body: { ok: true, updatedAt: 'b'.repeat(32) } });
    expect(Object.keys(update.mock.calls[0][0].data)).toEqual(['content']);
    expect(sql[0]).toContain('"PublicDraftRequest"');
    expect(sql[0]).toContain(DRAFT_HUELLA_SQL);
    expect(sql[0]).toContain('FOR UPDATE');
  });

  it('si cambió mientras estaba abierto, o es del diseño antiguo, no guarda', async () => {
    const stale = fakePrisma([]);
    expect(await savePublicDraftContent(stale.prisma, ID, { content: content(), baseUpdatedAt: HUELLA })).toEqual({ status: 409, body: { error: 'stale_draft' } });
    const old = fakePrisma([{ template_id: null }]);
    expect(await savePublicDraftContent(old.prisma, ID, { content: content(), baseUpdatedAt: HUELLA })).toEqual({ status: 409, body: { error: 'old_design' } });
    expect(stale.update).not.toHaveBeenCalled();
    expect(old.update).not.toHaveBeenCalled();
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
