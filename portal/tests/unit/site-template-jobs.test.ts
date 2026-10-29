import { describe, expect, it, vi, beforeEach } from 'vitest';

const ai = vi.hoisted(() => ({ generate: vi.fn(), repair: vi.fn() }));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/site-template-ai', () => ({
  generateSiteTemplate: (...a: unknown[]) => ai.generate(...a),
  repairSiteTemplate: (...a: unknown[]) => ai.repair(...a),
}));

import type { PrismaClient } from '@prisma/client';
import {
  MAX_REPAIR_ROUNDS,
  SITE_TEMPLATE_DAILY_CAP,
  pickSiteTemplateForSector,
  recordBrowserChecks,
  recoverStaleJobs,
  restoreSiteTemplateVersion,
  setSiteTemplateState,
  startSiteTemplateGeneration,
} from '@/lib/site-template-jobs';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

type Row = Record<string, unknown> & { id: string; estado: string; validacion: Record<string, unknown> };

/** Prisma en memoria, solo lo que usa site-template-jobs. */
function fakePrisma(seed: Row[] = [], todayCount = 0, drafts: { leadId: string; templateId: string | null }[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  let n = 0;
  const prisma = {
    prospectingWebDraft: {
      groupBy: vi.fn(async ({ where }: { where: { templateId: { in: string[] }; leadId?: { not: string } } }) => {
        const counts = new Map<string, number>();
        for (const d of drafts) {
          if (!d.templateId || !where.templateId.in.includes(d.templateId) || d.leadId === where.leadId?.not) continue;
          counts.set(d.templateId, (counts.get(d.templateId) ?? 0) + 1);
        }
        return [...counts].map(([templateId, n]) => ({ templateId, _count: { _all: n } }));
      }),
    },
    siteTemplate: {
      count: vi.fn(async () => todayCount),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `t${++n}`;
        rows.set(id, { id, ...data } as Row);
        return { id };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id) as Row;
        Object.assign(row, data);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('sector' in where) {
          return [...rows.values()]
            .filter((r) => r.sector === where.sector && r.estado === 'aprobada')
            .map((r) => ({ id: r.id, _count: { websites: (r.websites as number) ?? 0 } }));
        }
        return [...rows.values()].filter((r) => ['generando', 'corrigiendo'].includes(r.estado) && (r.updatedAt as Date) < (where.updatedAt as { lt: Date }).lt);
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

const brief = { sector: 'trades', encargo: 'Fontanería con urgencias, confianza y limpieza.' };
const generated = (template = SITE_TEMPLATE_BASE) => ({ ok: true, template, model: 'claude-sonnet-5-5', usage: { output_tokens: 25000 }, costUsd: 0.26, seconds: 150 });

beforeEach(() => {
  ai.generate.mockReset();
  ai.repair.mockReset();
});

describe('startSiteTemplateGeneration', () => {
  it('con tope diario alcanzado no crea nada ni llama a la IA', async () => {
    const { prisma } = fakePrisma([], SITE_TEMPLATE_DAILY_CAP);
    expect(await startSiteTemplateGeneration(prisma, { nombre: 'x', brief })).toEqual({ ok: false, error: 'daily_cap_reached' });
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('una plantilla que pasa el validador queda pendiente del navegador, con su coste', async () => {
    const { prisma, rows } = fakePrisma();
    ai.generate.mockResolvedValue(generated());
    let job: Promise<void> = Promise.resolve();
    const r = await startSiteTemplateGeneration(prisma, { nombre: 'Oficios', brief }, { run: (p) => (job = p) });
    expect(r).toEqual({ ok: true, id: 't1' });
    expect(rows.get('t1')?.estado).toBe('generando');
    await job;
    const row = rows.get('t1') as Row;
    expect(row.estado).toBe('pendiente_navegador');
    expect(row.marco).toBe(SITE_TEMPLATE_BASE.marco);
    expect(row.validacion.costeUsd).toBe(0.26);
    expect(ai.repair).not.toHaveBeenCalled();
  });

  it('si el validador se queja, corrige; si no se arregla tras las rondas, fallida', async () => {
    const { prisma, rows } = fakePrisma();
    const broken = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, faq: undefined } };
    ai.generate.mockResolvedValue(generated(broken));
    ai.repair.mockResolvedValue({ ok: true, template: broken, diagnostico: 'nada', applied: 0, failed: [], model: 'm', usage: {}, costUsd: 0.01 });
    let job: Promise<void> = Promise.resolve();
    await startSiteTemplateGeneration(prisma, { nombre: 'Rota', brief }, { run: (p) => (job = p) });
    await job;
    const row = rows.get('t1') as Row;
    expect(ai.repair).toHaveBeenCalledTimes(2);
    expect(row.estado).toBe('fallida');
    expect((row.validacion.problemas as string[]).join()).toMatch(/falta la sección «faq»/);
    expect(row.validacion.costeUsd).toBe(0.28);
  });

  it('sin clave de Anthropic queda fallida y lo dice', async () => {
    const { prisma, rows } = fakePrisma();
    ai.generate.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    let job: Promise<void> = Promise.resolve();
    await startSiteTemplateGeneration(prisma, { nombre: 'x', brief }, { run: (p) => (job = p) });
    await job;
    expect(rows.get('t1')?.estado).toBe('fallida');
    expect(rows.get('t1')?.validacion.problemas).toEqual(['no_api_key']);
  });
});

describe('recordBrowserChecks', () => {
  const pending = (over: Partial<Row> = {}): Row => ({
    id: 'p1',
    estado: 'pendiente_navegador',
    marco: SITE_TEMPLATE_BASE.marco,
    secciones: SITE_TEMPLATE_BASE.secciones,
    modelo: null,
    validacion: { encargo: 'x', rondas: 0, costeUsd: 0.26, problemas: [], historial: [] },
    ...over,
  });

  it('sin fallos queda lista para aprobar', async () => {
    const { prisma, rows } = fakePrisma([pending()]);
    const r = await recordBrowserChecks(prisma, 'p1', [{ ancho: 360, contenido: 'normal', problemas: [] }]);
    expect(r).toEqual({ ok: true, estado: 'lista', problemas: [] });
    expect(rows.get('p1')?.estado).toBe('lista');
  });

  it('con fallos, corrige en segundo plano y vuelve a pedir el navegador', async () => {
    const { prisma, rows } = fakePrisma([pending()]);
    ai.repair.mockResolvedValue({ ok: true, template: SITE_TEMPLATE_BASE, diagnostico: 'auto-fill', applied: 1, failed: [], model: 'm', usage: {}, costUsd: 0.02 });
    let job: Promise<void> = Promise.resolve();
    const r = await recordBrowserChecks(prisma, 'p1', [{ ancho: 360, contenido: 'exagerado', problemas: ['Desborde horizontal…'] }], { run: (p) => (job = p) });
    expect(r).toMatchObject({ ok: true, estado: 'corrigiendo' });
    await job;
    expect(ai.repair.mock.calls[0][1][0]).toMatch(/Desborde horizontal… \(visto a 360 px, contenido exagerado\)/);
    expect(rows.get('p1')?.estado).toBe('pendiente_navegador');
    expect(rows.get('p1')?.validacion.rondas).toBe(1);
  });

  it('una hecha a mano con fallos queda fallida: la IA no reescribe un diseño que no es suyo', async () => {
    const { prisma, rows } = fakePrisma([pending({ origen: 'manual' })]);
    ai.repair.mockClear();
    const r = await recordBrowserChecks(prisma, 'p1', [{ ancho: 1100, contenido: 'exagerado', problemas: ['Contraste insuficiente…'] }]);
    expect(r).toMatchObject({ ok: true, estado: 'fallida' });
    expect(rows.get('p1')?.estado).toBe('fallida');
    expect(rows.get('p1')?.validacion.problemas).toEqual(['Contraste insuficiente… (visto a 1100 px, contenido exagerado)']);
    expect(ai.repair).not.toHaveBeenCalled();
  });

  it('si algún marco no llegó a cargar, no juzga el diseño: sigue pendiente', async () => {
    const { prisma, rows } = fakePrisma([pending({ origen: 'manual' })]);
    const runs = [360, 1100].map((ancho) => ({ ancho, contenido: 'normal' as const, problemas: ['No se pudo leer la vista previa.'] }));
    expect(await recordBrowserChecks(prisma, 'p1', runs)).toEqual({ ok: false, error: 'preview_unreadable' });
    expect(rows.get('p1')?.estado).toBe('pendiente_navegador');
    // 28/10: tres pasadas de 56 sin cargar (un despliegue a medias) y el
    // resto bien. Tampoco cuenta: se vuelve a medir entera.
    const mixed = [...runs, { ancho: 1280, contenido: 'normal' as const, problemas: [] }];
    expect(await recordBrowserChecks(prisma, 'p1', mixed)).toEqual({ ok: false, error: 'preview_unreadable' });
    expect(rows.get('p1')?.estado).toBe('pendiente_navegador');
    // Con todo cargado, un fallo de verdad sí cuenta.
    const real = [{ ancho: 1280, contenido: 'normal' as const, problemas: ['Contraste insuficiente…'] }];
    expect(await recordBrowserChecks(prisma, 'p1', real)).toMatchObject({ ok: true, estado: 'fallida' });
  });

  it('sin rondas disponibles, fallida; y en otro estado no acepta medidas', async () => {
    const { prisma, rows } = fakePrisma([pending({ validacion: { rondas: MAX_REPAIR_ROUNDS, problemas: [], historial: [] } }), pending({ id: 'a1', estado: 'aprobada' })]);
    expect(await recordBrowserChecks(prisma, 'p1', [{ ancho: 360, contenido: 'normal', problemas: ['x'] }])).toMatchObject({ estado: 'fallida' });
    expect(rows.get('p1')?.estado).toBe('fallida');
    expect(await recordBrowserChecks(prisma, 'a1', [{ ancho: 360, contenido: 'normal', problemas: [] }])).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('estados y biblioteca', () => {
  it('solo se aprueba lo que está lista y solo se retira lo aprobado', async () => {
    const { prisma, rows } = fakePrisma([
      { id: 'l', estado: 'lista', validacion: {} },
      { id: 'g', estado: 'generando', validacion: {} },
    ]);
    expect(await setSiteTemplateState(prisma, 'g', 'aprobar', null)).toEqual({ ok: false, error: 'wrong_state' });
    expect(await setSiteTemplateState(prisma, 'l', 'aprobar', 'op@k.es')).toEqual({ ok: true, estado: 'aprobada' });
    expect(await setSiteTemplateState(prisma, 'l', 'retirar', null)).toEqual({ ok: true, estado: 'retirada' });
    expect(rows.get('l')?.estado).toBe('retirada');
  });

  it('los trabajos colgados por un reinicio pasan a fallida', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const { prisma, rows } = fakePrisma([{ id: 's', estado: 'generando', updatedAt: old, validacion: {} }]);
    expect(await recoverStaleJobs(prisma)).toBe(1);
    expect(rows.get('s')?.estado).toBe('fallida');
  });

  it('para un sector, la aprobada menos usada; sin ninguna, null (sirve la base)', async () => {
    const { prisma } = fakePrisma([
      { id: 'a', estado: 'aprobada', sector: 'trades', websites: 3, validacion: {} },
      { id: 'b', estado: 'aprobada', sector: 'trades', websites: 1, validacion: {} },
      { id: 'c', estado: 'retirada', sector: 'trades', websites: 0, validacion: {} },
    ]);
    expect(await pickSiteTemplateForSector(prisma, 'trades')).toEqual({ id: 'b' });
    expect(await pickSiteTemplateForSector(prisma, 'beauty')).toBeNull();
    expect(await pickSiteTemplateForSector(prisma, null)).toBeNull();
  });

  // 29/10/2026 — sin webs de clientes todavía, todas empataban a cero y
  // todos los borradores habrían ido a la misma.
  const tres = (): Row[] => ['a', 'b', 'c'].map((id) => ({ id, estado: 'aprobada', sector: 'trades', websites: 0, validacion: {} }));

  it('cuenta también los borradores: va a la que menos tiene', async () => {
    const { prisma } = fakePrisma(tres(), 0, [
      { leadId: 'l1', templateId: 'a' },
      { leadId: 'l2', templateId: 'a' },
      { leadId: 'l3', templateId: 'c' },
    ]);
    expect(await pickSiteTemplateForSector(prisma, 'trades')).toEqual({ id: 'b' });
  });

  it('en un empate, al azar entre las empatadas (y solo entre ellas)', async () => {
    const { prisma } = fakePrisma(tres(), 0, [{ leadId: 'l1', templateId: 'b' }]);
    expect(await pickSiteTemplateForSector(prisma, 'trades', { random: () => 0 })).toEqual({ id: 'a' });
    expect(await pickSiteTemplateForSector(prisma, 'trades', { random: () => 0.99 })).toEqual({ id: 'c' });
    expect(await pickSiteTemplateForSector(prisma, 'trades', { random: () => 1 })).toEqual({ id: 'c' });
  });

  it('el borrador que se regenera no cuenta: sale como la primera vez', async () => {
    const { prisma } = fakePrisma(tres().slice(0, 2), 0, [{ leadId: 'l1', templateId: 'a' }]);
    expect(await pickSiteTemplateForSector(prisma, 'trades', { random: () => 0 })).toEqual({ id: 'b' });
    expect(await pickSiteTemplateForSector(prisma, 'trades', { exceptDraftLeadId: 'l1', random: () => 0 })).toEqual({ id: 'a' });
  });

  it('repartiendo uno tras otro, los borradores quedan a partes iguales', async () => {
    const drafts: { leadId: string; templateId: string | null }[] = [];
    const { prisma } = fakePrisma(tres(), 0, drafts);
    for (let i = 0; i < 12; i++) drafts.push({ leadId: `l${i}`, templateId: (await pickSiteTemplateForSector(prisma, 'trades'))!.id });
    expect(['a', 'b', 'c'].map((id) => drafts.filter((d) => d.templateId === id).length)).toEqual([4, 4, 4]);
  });
});

describe('correcciones de una aprobada (29/10/2026)', () => {
  /** El Prisma en memoria de arriba, con la transacción y el historial. */
  function withVersions(seed: Row[]) {
    const base = fakePrisma(seed);
    const versiones: Record<string, unknown>[] = [];
    const p = base.prisma as unknown as Record<string, unknown>;
    p.siteTemplateVersion = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        versiones.push({ id: `v${versiones.length + 1}`, createdAt: new Date('2026-10-29T10:00:00Z'), ...data });
        return {};
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; templateId: string } }) => versiones.find((v) => v.id === where.id && v.templateId === where.templateId) ?? null),
    };
    p.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(p));
    return { ...base, versiones };
  }
  const vigente = { id: 'cercano', nombre: 'Oficios · Cercano', estado: 'aprobada', marco: '.mapa{width:min(100%,22rem)}', secciones: { zona: '<div class="mapa">' }, estilo: { a: 1 }, validacion: {} };
  const fix = { id: 'fix', nombre: 'Oficios · Cercano · corrección', estado: 'lista', correccionDe: 'cercano', marco: '.mapa{width:min(74%,22rem)}', secciones: { zona: '<div class="mapa">' }, estilo: { a: 1 }, validacion: { encargo: 'La mancha del mapa desbordaba en móvil' } };

  it('aplicarla guarda lo que había, pone el arreglo en la original (mismo id) y la deja aplicada', async () => {
    const { prisma, rows, versiones } = withVersions([{ ...vigente }, { ...fix }]);
    expect(await setSiteTemplateState(prisma, 'fix', 'aprobar', 'op@k.es')).toEqual({ ok: true, estado: 'aplicada' });
    expect(rows.get('cercano')).toMatchObject({ estado: 'aprobada', marco: fix.marco });
    expect(rows.get('fix')?.estado).toBe('aplicada');
    expect(versiones).toHaveLength(1);
    expect(versiones[0]).toMatchObject({ templateId: 'cercano', marco: vigente.marco, motivo: 'La mancha del mapa desbordaba en móvil', correccionId: 'fix', actorEmail: 'op@k.es' });
    expect(JSON.stringify(rows.get('cercano')?.validacion)).toMatch(/Corrección «Oficios · Cercano · corrección» aplicada por op@k\.es/);
  });

  it('solo si la corrección está lista y la original sigue aprobada', async () => {
    const pendiente = withVersions([{ ...vigente }, { ...fix, estado: 'pendiente_navegador' }]);
    expect(await setSiteTemplateState(pendiente.prisma, 'fix', 'aprobar', null)).toEqual({ ok: false, error: 'wrong_state' });
    const retirada = withVersions([{ ...vigente, estado: 'retirada' }, { ...fix }]);
    expect(await setSiteTemplateState(retirada.prisma, 'fix', 'aprobar', null)).toEqual({ ok: false, error: 'wrong_state' });
    expect(retirada.rows.get('cercano')?.marco).toBe(vigente.marco);
    expect(retirada.versiones).toHaveLength(0);
  });

  it('se puede descartar; una plantilla normal no', async () => {
    const { prisma, rows } = withVersions([{ ...vigente }, { ...fix }]);
    expect(await setSiteTemplateState(prisma, 'fix', 'descartar', null)).toEqual({ ok: true, estado: 'descartada' });
    expect(rows.get('cercano')?.marco).toBe(vigente.marco);
    expect(await setSiteTemplateState(prisma, 'cercano', 'descartar', null)).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('volver a la versión anterior deja lo de ahora en el historial (se deshace igual)', async () => {
    const { prisma, rows, versiones } = withVersions([{ ...vigente }, { ...fix }]);
    await setSiteTemplateState(prisma, 'fix', 'aprobar', null);
    expect(await restoreSiteTemplateVersion(prisma, 'cercano', 'v1', 'op@k.es')).toEqual({ ok: true, estado: 'aprobada' });
    expect(rows.get('cercano')?.marco).toBe(vigente.marco);
    expect(versiones).toHaveLength(2);
    expect(versiones[1]).toMatchObject({ templateId: 'cercano', marco: fix.marco });
    // Una versión de otra plantilla no vale.
    expect(await restoreSiteTemplateVersion(prisma, 'fix', 'v1', null)).toEqual({ ok: false, error: 'not_found' });
  });
});
