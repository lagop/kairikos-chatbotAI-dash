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
  setSiteTemplateState,
  startSiteTemplateGeneration,
} from '@/lib/site-template-jobs';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

type Row = Record<string, unknown> & { id: string; estado: string; validacion: Record<string, unknown> };

/** Prisma en memoria, solo lo que usa site-template-jobs. */
function fakePrisma(seed: Row[] = [], todayCount = 0) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  let n = 0;
  const prisma = {
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
});
