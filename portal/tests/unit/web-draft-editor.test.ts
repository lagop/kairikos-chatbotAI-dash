import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/web-draft-live', () => ({ getLiveDraftData: vi.fn(async () => null) }));

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { loadDraftEditor, saveDraftContent, serveDraftPreview } from '@/lib/web-draft-editor';
import { DRAFT_HUELLA_SQL } from '@/lib/web-draft-edit';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

// 30/10/2026 — el borrador de un prospecto, guardado desde el editor de webs
// por el operador (lib/web-draft-editor.ts).

const LEAD = '11111111-1111-4111-8111-111111111111';
const TPL = '22222222-2222-4222-8222-222222222222';
const HUELLA = 'a'.repeat(32);
const NUEVA = 'b'.repeat(32);
const OLD = { id: 'draft-1', copy: { headline: 'Viejo' }, content: { viejo: true }, templateId: TPL, themeKey: 'trades-2' };
const content = () => structuredClone(SITE_CONTENT_SAMPLES.normal);

function fakePrisma(opts: { locked?: boolean; exists?: boolean; old?: typeof OLD | { templateId: null } } = {}) {
  const calls = { sql: [] as string[], version: vi.fn(), update: vi.fn() };
  const queryRaw = vi.fn(async (q: Prisma.Sql) => {
    calls.sql.push(q.sql);
    if (/FOR UPDATE/.test(q.sql)) return opts.locked === false ? [] : [{ id: 'draft-1' }];
    return [{ huella: NUEVA }];
  });
  const tx = {
    $queryRaw: queryRaw,
    prospectingWebDraft: {
      findUnique: vi.fn(async () => (opts.exists === false ? null : { id: 'draft-1' })),
      findUniqueOrThrow: vi.fn(async () => opts.old ?? OLD),
      update: calls.update,
    },
    prospectingWebDraftVersion: { create: calls.version },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
  return { prisma, calls };
}

describe('guardar el borrador desde el editor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('guarda el contenido, deja la versión anterior en el historial a nombre del operador y devuelve la huella nueva', async () => {
    const { prisma, calls } = fakePrisma();
    const r = await saveDraftContent(prisma, LEAD, { content: content(), baseUpdatedAt: HUELLA, phone: '600', address: 'x' }, 'op-1');
    expect(r).toEqual({ status: 200, body: { ok: true, updatedAt: NUEVA } });
    expect(calls.version).toHaveBeenCalledWith({
      data: { draftId: 'draft-1', accion: 'editado', actorId: 'op-1', copy: OLD.copy, content: OLD.content, templateId: TPL, themeKey: 'trades-2' },
    });
    // Solo el contenido: ni el texto de la generación, ni la plantilla, ni
    // el teléfono que manda el editor (en un borrador sale de Google).
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(calls.update.mock.calls[0][0].data)).toEqual(['content']);
    // La misma huella que la herramienta (scripts/borrador-web.ts).
    expect(calls.sql[0]).toContain(DRAFT_HUELLA_SQL);
    expect(calls.sql[0]).toContain('FOR UPDATE');
  });

  it('si el borrador cambió mientras estaba abierto (regenerado, retocado), se niega', async () => {
    const { prisma, calls } = fakePrisma({ locked: false });
    expect(await saveDraftContent(prisma, LEAD, { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).toEqual({ status: 409, body: { error: 'stale_draft' } });
    expect(calls.update).not.toHaveBeenCalled();
    expect(calls.version).not.toHaveBeenCalled();
    const gone = fakePrisma({ locked: false, exists: false });
    expect((await saveDraftContent(gone.prisma, LEAD, { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).status).toBe(404);
  });

  it('valida antes de tocar nada: contenido que no se pintaría, huella o prospecto que no lo son', async () => {
    const { prisma } = fakePrisma();
    const malo = { ...content(), datos: { ...content().datos, titular: 'x'.repeat(500) } };
    const r = await saveDraftContent(prisma, LEAD, { content: malo, baseUpdatedAt: HUELLA }, 'op-1');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_content');
    expect(Array.isArray(r.body.issues)).toBe(true);
    expect((await saveDraftContent(prisma, LEAD, { content: content() }, 'op-1')).status).toBe(400);
    expect((await saveDraftContent(prisma, 'no-es-uuid', { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('un borrador del diseño antiguo no se guarda: no tiene plantilla con la que pintarse', async () => {
    const { prisma, calls } = fakePrisma({ old: { ...OLD, templateId: null } as never });
    expect(await saveDraftContent(prisma, LEAD, { content: content(), baseUpdatedAt: HUELLA }, 'op-1')).toEqual({ status: 409, body: { error: 'old_design' } });
    expect(calls.update).not.toHaveBeenCalled();
  });
});

describe('abrir el editor y su vista en vivo', () => {
  const lead = (draft: Record<string, unknown> | null) => ({
    contactName: 'Fontanería Pérez',
    contactPhone: '+34600000000',
    summary: 'Negocio encontrado en Calle Mayor 1, Telde, España.',
    primaryType: 'plumber',
    searchLocation: 'Telde',
    externalPlaceId: null,
    competitorSnapshot: null,
    webDraft: draft,
  });
  const prismaWith = (l: unknown) =>
    ({
      lead: { findUnique: vi.fn(async () => l) },
      siteTemplate: { findUnique: vi.fn(async () => ({ marco: SITE_TEMPLATE_BASE.marco, secciones: SITE_TEMPLATE_BASE.secciones, estilo: null })) },
      $queryRaw: vi.fn(async () => [{ huella: HUELLA }]),
    }) as unknown as PrismaClient;

  it('carga el contenido con la huella; el diseño antiguo y lo que no existe, con su motivo', async () => {
    const ok = await loadDraftEditor(prismaWith(lead({ id: 'd', copy: {}, content: content(), templateId: TPL, themeKey: 'trades-1' })), LEAD);
    expect(ok.ok && ok.huella).toBe(HUELLA);
    expect(ok.ok && ok.negocio).toBe('Fontanería Pérez');
    expect(await loadDraftEditor(prismaWith(lead({ id: 'd', copy: {}, content: null, templateId: null, themeKey: 'trades-1' })), LEAD)).toEqual({ ok: false, reason: 'old_design' });
    expect(await loadDraftEditor(prismaWith(lead(null)), LEAD)).toEqual({ ok: false, reason: 'not_found' });
    expect(await loadDraftEditor(prismaWith(null), 'x')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('la vista pinta lo escrito sin guardar, como /borrador y en modo edición', async () => {
    const escrito = content();
    escrito.datos.titular = 'Titular escrito ahora mismo';
    const res = await serveDraftPreview(prismaWith(lead({ id: 'd', copy: { headline: 'h' }, content: content(), templateId: TPL, themeKey: 'trades-1' })), LEAD, { content: escrito, phone: null, address: null });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Titular escrito ahora mismo');
    expect(html).toContain('Propuesta de Kairikos para');
    expect(html).toMatch(/data-k-ruta="titular"/);
    // Lo que no valida no se pinta: el editor lo enseña como «algún campo no cuadra».
    const malo = await serveDraftPreview(prismaWith(lead({ id: 'd', copy: {}, content: content(), templateId: TPL, themeKey: 'trades-1' })), LEAD, { content: { roto: true }, phone: null, address: null });
    expect(malo.status).toBe(422);
  });
});
