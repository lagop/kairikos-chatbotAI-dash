import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { listDraftVersions, restoreDraftVersion } from '@/lib/draft-versions';

// 31/10/2026 — «Versiones anteriores» de los dos editores de borradores
// (lib/draft-versions.ts).

const LEAD = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const PUB = '33333333-3333-4333-8333-333333333333';
const VER = '44444444-4444-4444-8444-444444444444';
const OP = '55555555-5555-4555-8555-555555555555';

const NOW = { copy: { headline: 'ahora' }, content: { v: 'ahora' }, templateId: 'tpl-ahora', themeKey: 'trades-2' };
const OLD = { copy: { headline: 'antes' }, content: { v: 'antes' }, templateId: 'tpl-antes', themeKey: 'trades-1' };

function fake(version: Record<string, unknown> | null) {
  const created: Array<{ table: string; data: Record<string, unknown> }> = [];
  const updated: Array<{ table: string; args: { where: unknown; data: Record<string, unknown> } }> = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    operator: { findMany: vi.fn(async () => [{ id: OP, email: 'orlando@example.com' }]) },
    prospectingWebDraft: {
      findUnique: vi.fn(async () => ({ id: DRAFT })),
      findUniqueOrThrow: vi.fn(async () => NOW),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => updated.push({ table: 'prospecting', args })),
    },
    prospectingWebDraftVersion: {
      findFirst: vi.fn(async () => version),
      findMany: vi.fn(async () => [
        { id: VER, accion: 'editado', nota: null, actorId: OP, createdAt: new Date('2026-10-31T10:00:00Z'), templateId: 'tpl', content: {} },
        { id: 'v2', accion: 'retoque', nota: 'titular', actorId: 'system:claude-code', createdAt: new Date('2026-10-30T10:00:00Z'), templateId: null, content: null },
      ]),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => created.push({ table: 'prospecting', data: a.data })),
    },
    publicDraftRequest: {
      findUniqueOrThrow: vi.fn(async () => NOW),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => updated.push({ table: 'public', args })),
    },
    publicDraftVersion: {
      findFirst: vi.fn(async () => version),
      findMany: vi.fn(async () => []),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => created.push({ table: 'public', data: a.data })),
    },
  };
  const prisma = { ...db, $transaction: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)) } as unknown as PrismaClient;
  return { prisma, db, created, updated };
}

describe('lista de versiones', () => {
  it('dice quién y si es del diseño antiguo', async () => {
    const { prisma } = fake(null);
    const rows = await listDraftVersions(prisma, { kind: 'prospecting', leadId: LEAD });
    expect(rows).toEqual([
      { id: VER, accion: 'editado', nota: null, autor: 'orlando@example.com', createdAt: '2026-10-31T10:00:00.000Z', conPlantilla: true },
      { id: 'v2', accion: 'retoque', nota: 'titular', autor: 'Claude Code', createdAt: '2026-10-30T10:00:00.000Z', conPlantilla: false },
    ]);
  });

  it('con un id que no es uuid no consulta nada', async () => {
    const { prisma, db } = fake(null);
    expect(await listDraftVersions(prisma, { kind: 'public', id: 'x' })).toEqual([]);
    expect(db.publicDraftVersion.findMany).not.toHaveBeenCalled();
  });
});

describe('volver a una versión', () => {
  it('de prospección: guarda lo de ahora como «restaurado» y pone los cuatro campos de la versión', async () => {
    const { prisma, db, created, updated } = fake({ id: VER, draftId: DRAFT, ...OLD });
    const r = await restoreDraftVersion(prisma, { kind: 'prospecting', leadId: LEAD }, VER, OP);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(db.prospectingWebDraftVersion.findFirst).toHaveBeenCalledWith({ where: { id: VER, draftId: DRAFT } });
    expect(created).toEqual([{ table: 'prospecting', data: expect.objectContaining({ draftId: DRAFT, accion: 'restaurado', actorId: OP, ...NOW }) }]);
    expect(updated).toEqual([{ table: 'prospecting', args: { where: { id: DRAFT }, data: OLD } }]);
  });

  it('de kairikos.com: lo mismo en su tabla, y una versión sin contenido lo deja en null de base de datos', async () => {
    const { prisma, created, updated } = fake({ id: VER, requestId: PUB, ...OLD, copy: null, content: null });
    const r = await restoreDraftVersion(prisma, { kind: 'public', id: PUB }, VER, OP);
    expect(r.status).toBe(200);
    expect(created[0]).toEqual({ table: 'public', data: expect.objectContaining({ requestId: PUB, accion: 'restaurado', content: NOW.content }) });
    expect(updated[0].args.data).toEqual({ copy: Prisma.DbNull, content: Prisma.DbNull, templateId: OLD.templateId, themeKey: OLD.themeKey });
  });

  it('una versión de otro borrador no se aplica', async () => {
    const { prisma, created, updated } = fake(null);
    expect(await restoreDraftVersion(prisma, { kind: 'public', id: PUB }, VER, OP)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await restoreDraftVersion(prisma, { kind: 'prospecting', leadId: LEAD }, 'nope', OP)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
});
