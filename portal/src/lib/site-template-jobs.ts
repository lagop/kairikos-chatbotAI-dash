import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { logError } from './observability';
import type { SiteTemplatePart, SiteTemplateSource } from './site-template';
import { validateSiteTemplate } from './site-template-validate';
import { generateSiteTemplate, repairSiteTemplate, type SiteTemplateBrief } from './site-template-ai';
import { LOAD_FAILURE_PREFIXES, summarizeCheckRuns, type CheckRun } from './site-template-checks';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — el ciclo de vida de una plantilla que
// diseña la IA, de que el operador la encarga a que la aprueba.
//
//   generando ──► (validador + hasta 2 rondas) ──► pendiente_navegador
//        │                                              │ el navegador del operador la pinta y la mide
//        ▼                                              ▼
//     fallida ◄── sin arreglo tras las rondas ── corrigiendo ◄── con fallos
//                                                       │ sin fallos
//                                                       ▼
//                                                     lista ──► aprobada ──► retirada
//
// Generar tarda 2–3 minutos, así que corre en segundo plano dentro del propio
// proceso de Node (este stack es un servidor que vive, no funciones que se
// apagan al responder). Si el contenedor se reinicia a medias, la fila se
// queda en «generando»: recoverStaleJobs la pasa a fallida al abrir la página.
//
// Lo que cuesta dinero tiene tope: SITE_TEMPLATE_DAILY_CAP generaciones al día
// y MAX_REPAIR_ROUNDS rondas por plantilla. Una plantilla con Sonnet son unos
// 0,26 $; el tope es para que un botón pulsado en bucle no sea una factura.
//
// Inmutable una vez APROBADA (ver SiteTemplate en schema.prisma): antes, las
// rondas de corrección la reescriben; después, corregirla es encargar otra.
// =============================================================================

export const SITE_TEMPLATE_DAILY_CAP = 15;
export const MAX_REPAIR_ROUNDS = 4;
const STATIC_REPAIR_ROUNDS = 2;
const STALE_AFTER_MS = 15 * 60 * 1000;

export type SiteTemplateEstado =
  | 'generando'
  | 'corrigiendo'
  | 'pendiente_navegador'
  | 'lista'
  | 'fallida'
  | 'aprobada'
  | 'retirada';

export interface SiteTemplateLogEntry {
  fase: 'generacion' | 'validador' | 'correccion' | 'navegador' | 'aprobacion' | 'retirada' | 'error';
  at: string;
  detalle: string;
  problemas?: string[];
  costeUsd?: number | null;
  segundos?: number;
}

/** Lo que se guarda en SiteTemplate.validacion. */
export interface SiteTemplateValidacion {
  encargo: string;
  modelo?: string | null;
  rondas: number;
  costeUsd: number;
  problemas: string[];
  historial: SiteTemplateLogEntry[];
}

function asValidacion(raw: unknown, fallbackEncargo = ''): SiteTemplateValidacion {
  const v = (raw ?? {}) as Partial<SiteTemplateValidacion>;
  return {
    encargo: v.encargo ?? fallbackEncargo,
    modelo: v.modelo ?? null,
    rondas: v.rondas ?? 0,
    costeUsd: v.costeUsd ?? 0,
    problemas: v.problemas ?? [],
    historial: v.historial ?? [],
  };
}

function addCost(v: SiteTemplateValidacion, cost: number | null | undefined) {
  v.costeUsd = Math.round((v.costeUsd + (cost ?? 0)) * 10000) / 10000;
}

async function save(
  prisma: PrismaClient,
  id: string,
  data: { estado?: SiteTemplateEstado; template?: SiteTemplateSource; validacion: SiteTemplateValidacion },
) {
  await prisma.siteTemplate.update({
    where: { id },
    data: {
      ...(data.estado ? { estado: data.estado } : {}),
      ...(data.template ? { marco: data.template.marco, secciones: data.template.secciones as Prisma.InputJsonValue } : {}),
      validacion: data.validacion as unknown as Prisma.InputJsonValue,
    },
  });
}

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export type StartGenerationResult = { ok: true; id: string } | { ok: false; error: 'daily_cap_reached' };

/**
 * Encarga una plantilla. Devuelve en cuanto crea la fila; el trabajo sigue en
 * segundo plano (y `run` permite esperarlo en las pruebas).
 */
export async function startSiteTemplateGeneration(
  prisma: PrismaClient,
  input: { nombre: string; brief: SiteTemplateBrief; modelo?: string | null },
  options: { now?: Date; run?: (p: Promise<void>) => void } = {},
): Promise<StartGenerationResult> {
  const now = options.now ?? new Date();
  const today = await prisma.siteTemplate.count({ where: { origen: 'ia', createdAt: { gte: startOfDay(now) } } });
  if (today >= SITE_TEMPLATE_DAILY_CAP) return { ok: false, error: 'daily_cap_reached' };

  const validacion: SiteTemplateValidacion = {
    encargo: input.brief.encargo,
    modelo: input.modelo ?? null,
    rondas: 0,
    costeUsd: 0,
    problemas: [],
    historial: [{ fase: 'generacion', at: now.toISOString(), detalle: 'Encargada' }],
  };
  const row = await prisma.siteTemplate.create({
    data: {
      nombre: input.nombre,
      sector: input.brief.sector,
      variante: input.brief.variante ?? null,
      origen: 'ia',
      modelo: input.modelo ?? null,
      marco: '',
      secciones: {},
      estado: 'generando',
      validacion: validacion as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const job = runGeneration(prisma, row.id, input.brief, input.modelo ?? null, validacion);
  (options.run ?? ((p) => void p))(job);
  return { ok: true, id: row.id };
}

/** El validador y, si se queja, rondas de corrección. Devuelve la plantilla
 *  saneada y lo que quede sin arreglar. */
async function validateAndRepair(
  template: SiteTemplateSource,
  validacion: SiteTemplateValidacion,
  modelo: string | null,
  rounds: number,
): Promise<{ template: SiteTemplateSource; problems: string[] }> {
  let current = template;
  for (let i = 0; ; i++) {
    const check = validateSiteTemplate(current);
    current = check.template;
    validacion.historial.push({
      fase: 'validador',
      at: new Date().toISOString(),
      detalle: check.ok
        ? `Sin problemas${check.removedAttributes.length ? ` (quitados: ${check.removedAttributes.join(', ')})` : ''}`
        : `${check.problems.length} problemas`,
      problemas: check.ok ? undefined : check.problems.slice(0, 20),
    });
    if (check.ok || i >= rounds || validacion.rondas >= MAX_REPAIR_ROUNDS) return { template: current, problems: check.problems };
    const repaired = await repairSiteTemplate(current, check.problems, { model: modelo });
    validacion.rondas++;
    addCost(validacion, repaired.costUsd);
    if (!repaired.ok) {
      validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: `Corrección fallida: ${repaired.error}` });
      return { template: current, problems: check.problems };
    }
    validacion.historial.push({
      fase: 'correccion',
      at: new Date().toISOString(),
      detalle: `${repaired.applied} cambios${repaired.failed.length ? `, ${repaired.failed.length} sin aplicar` : ''}. ${repaired.diagnostico}`,
      costeUsd: repaired.costUsd,
    });
    current = repaired.template;
  }
}

async function runGeneration(
  prisma: PrismaClient,
  id: string,
  brief: SiteTemplateBrief,
  modelo: string | null,
  validacion: SiteTemplateValidacion,
): Promise<void> {
  try {
    const generated = await generateSiteTemplate(brief, { model: modelo });
    if (!generated.ok) {
      addCost(validacion, generated.costUsd);
      validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: `Generación fallida: ${generated.error}`, costeUsd: generated.costUsd });
      validacion.problemas = [generated.error];
      await save(prisma, id, { estado: 'fallida', validacion });
      return;
    }
    if ('skipped' in generated) {
      validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: 'Sin clave de Anthropic configurada' });
      validacion.problemas = ['no_api_key'];
      await save(prisma, id, { estado: 'fallida', validacion });
      return;
    }
    validacion.modelo = generated.model;
    addCost(validacion, generated.costUsd);
    validacion.historial.push({
      fase: 'generacion',
      at: new Date().toISOString(),
      detalle: `Generada con ${generated.model} (${generated.usage.output_tokens ?? '?'} tokens de salida)`,
      costeUsd: generated.costUsd,
      segundos: generated.seconds,
    });
    const { template, problems } = await validateAndRepair(generated.template, validacion, modelo, STATIC_REPAIR_ROUNDS);
    validacion.problemas = problems;
    await save(prisma, id, { estado: problems.length ? 'fallida' : 'pendiente_navegador', template, validacion });
  } catch (err) {
    logError('site_template_jobs.generation_failed', err, { templateId: id }, 'warn');
    validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: err instanceof Error ? err.message : 'error' });
    await save(prisma, id, { estado: 'fallida', validacion }).catch(() => undefined);
  }
}

function rowTemplate(row: { marco: string; secciones: unknown }): SiteTemplateSource {
  return { marco: row.marco, secciones: (row.secciones ?? {}) as Partial<Record<SiteTemplatePart, string>> };
}

export type RecordChecksResult =
  | { ok: true; estado: SiteTemplateEstado; problemas: string[] }
  | { ok: false; error: 'not_found' | 'wrong_state' | 'preview_unreadable' };

/**
 * Lo que midió el navegador del operador. Sin fallos, la plantilla queda
 * lista para aprobar; con fallos y rondas disponibles, se corrige en segundo
 * plano y vuelve a «pendiente_navegador» para medirla otra vez.
 */
export async function recordBrowserChecks(
  prisma: PrismaClient,
  id: string,
  runs: CheckRun[],
  options: { run?: (p: Promise<void>) => void } = {},
): Promise<RecordChecksResult> {
  const row = await prisma.siteTemplate.findUnique({ where: { id } });
  if (!row) return { ok: false, error: 'not_found' };
  if (row.estado !== 'pendiente_navegador') return { ok: false, error: 'wrong_state' };
  // Si un marco no llegó a cargar, el fallo es del navegador o del portal, no
  // del diseño: la plantilla sigue pendiente y se vuelve a medir entera. El
  // 27/10 la cabecera frame-ancestors 'none' dejó en blanco las 21 pasadas y
  // las dos plantillas de oficios quedaron fallidas sin que nadie hubiera
  // medido nada. Al principio bastaba con que fallaran TODAS; el 28/10
  // «Encuadre» cayó fallida por tres pasadas de 56 que no cargaron porque el
  // despliegue estaba reiniciando el contenedor justo entonces. Basta UNA.
  const unreadable = (p: string) => LOAD_FAILURE_PREFIXES.some((prefix) => p.startsWith(prefix));
  if (runs.some((r) => r.problemas.some(unreadable))) {
    return { ok: false, error: 'preview_unreadable' };
  }
  const validacion = asValidacion(row.validacion);
  const problems = summarizeCheckRuns(runs);
  validacion.problemas = problems;
  validacion.historial.push({
    fase: 'navegador',
    at: new Date().toISOString(),
    detalle: problems.length ? `${problems.length} problemas en ${runs.length} pasadas` : `Sin problemas en ${runs.length} pasadas`,
    problemas: problems.length ? problems : undefined,
  });
  if (!problems.length) {
    await save(prisma, id, { estado: 'lista', validacion });
    return { ok: true, estado: 'lista', problemas: [] };
  }
  // Las escritas a mano (scripts/plantilla-a-mano.ts) no pasan por la ronda
  // de corrección: la IA reescribiría un diseño que no es suyo sin que nadie
  // lo vea. Se quedan fallidas con los problemas a la vista y se corrigen en
  // portal/plantillas/, donde viven.
  if (row.origen === 'manual' || validacion.rondas >= MAX_REPAIR_ROUNDS) {
    await save(prisma, id, { estado: 'fallida', validacion });
    return { ok: true, estado: 'fallida', problemas: problems };
  }
  await save(prisma, id, { estado: 'corrigiendo', validacion });
  const job = runRepair(prisma, id, rowTemplate(row), problems, row.modelo, validacion);
  (options.run ?? ((p) => void p))(job);
  return { ok: true, estado: 'corrigiendo', problemas: problems };
}

async function runRepair(
  prisma: PrismaClient,
  id: string,
  template: SiteTemplateSource,
  problems: string[],
  modelo: string | null,
  validacion: SiteTemplateValidacion,
): Promise<void> {
  try {
    const repaired = await repairSiteTemplate(template, problems, { model: modelo });
    validacion.rondas++;
    addCost(validacion, repaired.costUsd);
    if (!repaired.ok) {
      validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: `Corrección fallida: ${repaired.error}` });
      await save(prisma, id, { estado: 'fallida', validacion });
      return;
    }
    validacion.historial.push({
      fase: 'correccion',
      at: new Date().toISOString(),
      detalle: `${repaired.applied} cambios${repaired.failed.length ? `, ${repaired.failed.length} sin aplicar` : ''}. ${repaired.diagnostico}`,
      costeUsd: repaired.costUsd,
    });
    // Lo que arregla una ronda puede romper una regla del validador: se
    // vuelve a pasar antes de volver al navegador.
    const { template: next, problems: left } = await validateAndRepair(repaired.template, validacion, modelo, 1);
    validacion.problemas = left;
    await save(prisma, id, { estado: left.length ? 'fallida' : 'pendiente_navegador', template: next, validacion });
  } catch (err) {
    logError('site_template_jobs.repair_failed', err, { templateId: id }, 'warn');
    validacion.historial.push({ fase: 'error', at: new Date().toISOString(), detalle: err instanceof Error ? err.message : 'error' });
    await save(prisma, id, { estado: 'fallida', validacion }).catch(() => undefined);
  }
}

export type TemplateActionResult = { ok: true; estado: SiteTemplateEstado } | { ok: false; error: 'not_found' | 'wrong_state' };

/** Aprobar (solo si está lista), retirar (si está aprobada) o pedir otra
 *  ronda a una fallida que aún tiene rondas. */
export async function setSiteTemplateState(
  prisma: PrismaClient,
  id: string,
  action: 'aprobar' | 'retirar' | 'reintentar',
  actorEmail: string | null,
): Promise<TemplateActionResult> {
  const row = await prisma.siteTemplate.findUnique({ where: { id }, select: { estado: true, validacion: true } });
  if (!row) return { ok: false, error: 'not_found' };
  const validacion = asValidacion(row.validacion);
  const at = new Date().toISOString();
  const allowed: Record<typeof action, string[]> = { aprobar: ['lista'], retirar: ['aprobada'], reintentar: ['fallida'] };
  if (!allowed[action].includes(row.estado)) return { ok: false, error: 'wrong_state' };
  if (action === 'reintentar' && validacion.rondas >= MAX_REPAIR_ROUNDS) return { ok: false, error: 'wrong_state' };
  const estado: SiteTemplateEstado = action === 'aprobar' ? 'aprobada' : action === 'retirar' ? 'retirada' : 'pendiente_navegador';
  validacion.historial.push({
    fase: action === 'aprobar' ? 'aprobacion' : action === 'retirar' ? 'retirada' : 'navegador',
    at,
    detalle: action === 'reintentar' ? `Vuelve a comprobarse en el navegador (${actorEmail ?? 'operador'})` : `Por ${actorEmail ?? 'operador'}`,
  });
  await save(prisma, id, { estado, validacion });
  return { ok: true, estado };
}

/** Trabajos que se quedaron a medias por un reinicio. */
export async function recoverStaleJobs(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const stale = await prisma.siteTemplate.findMany({
    where: { estado: { in: ['generando', 'corrigiendo'] }, updatedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    select: { id: true, validacion: true },
  });
  for (const row of stale) {
    const validacion = asValidacion(row.validacion);
    validacion.historial.push({ fase: 'error', at: now.toISOString(), detalle: 'Interrumpida (el servidor se reinició a medias)' });
    await save(prisma, row.id, { estado: 'fallida', validacion });
  }
  return stale.length;
}

/** La plantilla aprobada de un sector para una web nueva, o null (entonces
 *  sirve la base). Entre varias, la menos usada: es el primer paso para que
 *  dos negocios del mismo sector no salgan iguales. */
export async function pickSiteTemplateForSector(prisma: PrismaClient, sector: string | null): Promise<{ id: string } | null> {
  if (!sector) return null;
  const rows = await prisma.siteTemplate.findMany({
    where: { sector, estado: 'aprobada' },
    select: { id: true, _count: { select: { websites: true } } },
  });
  if (!rows.length) return null;
  rows.sort((a, b) => a._count.websites - b._count.websites);
  return { id: rows[0].id };
}
