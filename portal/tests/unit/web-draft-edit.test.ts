// =============================================================================
// Retoque a mano de un borrador de prospecto (scripts/borrador-web.ts).
//
// Lo que se fija: que un archivo que no se pintaría no llega a guardarse (el
// borrador caería en silencio al diseño antiguo), que el SQL no se puede
// romper desde un texto, y que regenerar desde el portal deja el borrador
// anterior en el historial en vez de llevárselo.
//
// El SQL en sí se probó contra el Postgres local el 28/10/2026 (leer, guardar,
// huella caducada, historial, deshacer, plantilla sin aprobar, cascada): los
// tests mockean Prisma y no dicen nada de eso.
// =============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  lead: null as Record<string, unknown> | null,
  versionCreate: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    lead: { findUnique: vi.fn(async () => mockState.lead) },
    prospectingWebDraftVersion: { create: (...a: unknown[]) => mockState.versionCreate(...a) },
    prospectingWebDraft: { upsert: (...a: unknown[]) => mockState.upsert(...a) },
    $transaction: (...a: unknown[]) => mockState.transaction(...a),
  },
}));
vi.mock('@/lib/operator-session', () => ({ authenticateAdminRequest: vi.fn(async () => ({ ok: true, sessionId: 's', operatorId: 'op-1' })) }));
vi.mock('@/lib/web-draft-ai', () => ({
  generateWebDraftCopy: vi.fn(async () => ({ ok: true, model: 'm', copy: { headline: 'Nuevo', subheadline: '', about: '', services: [], callToAction: '' } })),
}));
vi.mock('@/lib/web-draft-live', () => ({ getLiveDraftData: vi.fn(async () => null) }));
vi.mock('@/lib/web-draft-design', () => ({ designForDraft: vi.fn(async () => null), renderDesignedDraft: vi.fn(async () => null) }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { draftReadSql, draftRestoreSql, draftSaveSql, draftSearchSql, parseDraftEdit, type DraftEditFile } from '@/lib/web-draft-edit';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

const LEAD = '1359d24f-ce2b-4ef7-abbc-51fc0a4f9514';
const TPL = '4bd956a5-d930-4783-85e6-08aca87a1240';
const COPY = { headline: 'Titular', subheadline: 'Sub', about: 'Sobre', services: [{ name: 'Corte', description: 'A tijera' }], callToAction: 'Llama', highlights: [] };
const file = (over: Partial<DraftEditFile> = {}) => ({ leadId: LEAD, huella: 'a'.repeat(32), negocio: 'X', copy: COPY, content: null, templateId: null, themeKey: 'beauty-2', ...over });

describe('parseDraftEdit', () => {
  it('acepta un borrador de solo textos y uno con diseño', () => {
    expect(parseDraftEdit(file()).ok).toBe(true);
    const r = parseDraftEdit(file({ content: structuredClone(SITE_CONTENT_SAMPLES.normal), templateId: TPL }));
    expect(r.ok).toBe(true);
  });

  it('rechaza lo que no se pintaría, con todos los motivos a la vez', () => {
    const r = parseDraftEdit({ ...file(), huella: 'x', themeKey: 'peluqueria', copy: { ...COPY, headline: '', extra: 1 }, content: { paginas: [] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/huella/);
    expect(r.errors.join('\n')).toMatch(/themeKey/);
    expect(r.errors.join('\n')).toMatch(/copy\.headline/);
    expect(r.errors.join('\n')).toMatch(/copy: Unrecognized key/);
    expect(r.errors.join('\n')).toMatch(/content y templateId van juntos/);
  });

  it('un texto más largo que lo que deja la generación no pasa', () => {
    expect(parseDraftEdit(file({ copy: { ...COPY, headline: 'x'.repeat(91) } })).ok).toBe(false);
    expect(parseDraftEdit(file({ copy: { ...COPY, services: Array.from({ length: 7 }, () => COPY.services[0]) } })).ok).toBe(false);
  });
});

describe('el SQL', () => {
  it('un texto con el delimitador dentro no cierra el literal', () => {
    const r = parseDraftEdit(file({ copy: { ...COPY, headline: 'Corte $b$; DROP TABLE "Lead"; --' } }));
    if (!r.ok) throw new Error(r.errors.join());
    const sql = draftSaveSql(r.edit, 'nota con $b_$ dentro', 'system:claude-code');
    // El literal usa una etiqueta que no aparece en ningún texto.
    expect(sql).toContain('$b__${"headline":"Corte $b$; DROP TABLE');
    expect(sql).toContain('$b__$nota con $b_$ dentro$b__$');
    expect(draftSearchSql("O'Brien $b$")).toContain("$b_$O'Brien $b$$b_$");
  });

  it('guardar: comprueba la huella, guarda lo anterior y solo admite plantillas aprobadas', () => {
    const r = parseDraftEdit(file({ content: structuredClone(SITE_CONTENT_SAMPLES.normal), templateId: TPL }));
    if (!r.ok) throw new Error(r.errors.join());
    const sql = draftSaveSql(r.edit, 'por qué', 'system:claude-code');
    const order = ['BEGIN;', `= '${'a'.repeat(32)}' FOR UPDATE`, "estado = 'aprobada'", 'INSERT INTO "ProspectingWebDraftVersion"', 'UPDATE "ProspectingWebDraft"', 'COMMIT;'];
    const at = order.map((s) => sql.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it('nada que no sea un uuid llega a una consulta', () => {
    expect(() => draftReadSql("x'; DROP TABLE x; --")).toThrow();
    expect(() => draftRestoreSql(LEAD, 'nope', 'a')).toThrow();
    expect(() => draftSaveSql({ ...file(), templateId: "x' OR 1=1" } as DraftEditFile, 'n', 'a')).toThrow();
  });
});

describe('regenerar desde el portal', () => {
  beforeEach(() => {
    mockState.versionCreate.mockReset().mockReturnValue('version-op');
    mockState.upsert.mockReset().mockResolvedValue({ shareToken: 'tok' });
    mockState.transaction.mockReset().mockImplementation(async (ops: unknown[]) => [{}, await ops[1]]);
  });

  const call = async () => {
    const { GET } = await import('@/app/api/admin/portal/prospecting/web-draft/[leadId]/route');
    const req = new Request(`http://x/api/admin/portal/prospecting/web-draft/${LEAD}?regenerar=1`) as never;
    return GET(req, { params: Promise.resolve({ leadId: LEAD }) });
  };
  const baseLead = { id: LEAD, clientId: 'c', tenantId: null, contactName: 'Peluquería', contactPhone: null, summary: null, primaryType: 'hair_salon', searchCategory: null, searchLocation: null, externalPlaceId: null, competitorSnapshot: null };

  it('guarda el borrador anterior, retoques incluidos, antes de sustituirlo', async () => {
    mockState.lead = { ...baseLead, webDraft: { id: 'd-1', copy: { headline: 'Retocado' }, content: null, templateId: null, themeKey: 'beauty-3', shareToken: 'tok', generatedAt: new Date() } };
    expect((await call()).status).toBe(200);
    expect(mockState.transaction).toHaveBeenCalledOnce();
    const data = mockState.versionCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ draftId: 'd-1', accion: 'regenerado', actorId: 'op-1', copy: { headline: 'Retocado' }, themeKey: 'beauty-3' });
  });

  it('la primera vez no hay nada que guardar', async () => {
    mockState.lead = { ...baseLead, webDraft: null };
    expect((await call()).status).toBe(200);
    expect(mockState.versionCreate).not.toHaveBeenCalled();
    expect(mockState.upsert).toHaveBeenCalledOnce();
  });
});
