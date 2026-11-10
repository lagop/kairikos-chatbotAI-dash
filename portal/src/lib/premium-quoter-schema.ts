import { z } from 'zod';
import { QUOTER_ICONS } from './premium-quoter-icons';
import type { QuoterData } from './premium-quoter-engine';

// =============================================================================
// Presupuestador de Web Premium — qué se puede guardar (09/11/2026).
//
// Los datos se editan a mano desde /admin/portal/settings/presupuestador y van
// directos a una página pública, sin commit ni revisión. Esta validación es esa
// revisión: un error aquí se lee en la pantalla de ajustes; sin ella se vería
// como una página rota o un precio raro delante de un cliente.
//
// Además de la forma, comprueba lo que la forma no ve: que un `patch` apunte a
// un paso que exista, que los iconos sean conocidos, que `pageScale` cubra las
// páginas.
//
// 11/11/2026 — ya no se anuncian plazas («quedan 3») ni un precio de lista
// tachado: sin plazas contadas de verdad ni nadie que haya pagado ese precio,
// las dos cosas son escasez y descuento de referencia inventados (Ley de
// Competencia Desleal). spotsLeft se sigue aceptando, opcional y sin efecto,
// porque las versiones ya guardadas lo llevan y el esquema es estricto: si
// dejara de existir, la versión publicada no pasaría la validación y la página
// se quedaría en blanco. Las cuotas, con 0, no se ofrecen: hoy solo se puede
// cobrar una entrada y un pago final.
// =============================================================================

const catalogRef = z.union([
  z.object({ code: z.string().min(1), addon: z.string().min(1) }).strict(),
  z.object({ code: z.string().min(1), tier: z.string().min(1), minusTier: z.string().min(1).optional() }).strict(),
]);

const num = z.number().finite();

const option = z
  .object({
    id: z.string().min(1).max(40),
    icon: z.string(),
    label: z.string().min(1),
    desc: z.string(),
    price: num.min(0).optional(),
    monthly: num.min(0).optional(),
    weeks: num.min(0).optional(),
    mult: num.positive().optional(),
    weeksMult: num.positive().optional(),
    scale: z.boolean().optional(),
    fixed: num.min(0).optional(),
    tag: z.string().optional(),
    catalog: catalogRef.optional(),
  })
  .strict();

const step = z
  .object({
    id: z.string().min(1).max(40),
    kicker: z.string(),
    title: z.string().min(1),
    sub: z.string(),
    type: z.enum(['single', 'multi']),
    optional: z.boolean().optional(),
    options: z.array(option),
  })
  .strict();

const hero = z.object({ h1: z.string().min(1), p: z.string() }).strict();

const patch = z
  .object({
    title: z.string().optional(),
    sub: z.string().optional(),
    opts: z.record(option.partial().strict()).optional(),
  })
  .strict();

const sector = z
  .object({
    name: z.string().min(1),
    icon: z.string(),
    blurb: z.string(),
    ticket: z.string(),
    tipoFactor: num.positive().optional(),
    hero,
    patch: z.record(patch),
    widgets: z.array(option),
    insights: z.array(
      z
        .object({
          when: z.object({ all: z.array(z.string()), none: z.array(z.string()) }).strict(),
          text: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const config = z
  .object({
    published: z.boolean(),
    currency: z.string().min(1).max(3),
    rangeLow: num.positive(),
    rangeHigh: num.positive(),
    baseWeeks: num.min(0),
    launch: z
      .object({
        enabled: z.boolean(),
        discount: num.min(0).max(0.9),
        spotsLeft: z.number().int().min(0).optional(),
        label: z.string().min(1),
      })
      .strict(),
    installments: z.number().int().min(0).max(60),
    included: z.array(z.string().min(1)),
    pageScale: z.record(num.positive()),
    ivaNote: z.string(),
    defaultHero: hero,
    socialProof: z.string().min(1).nullable(),
    thanksText: z.string().min(1),
  })
  .strict();

const dataSchema = z.object({ config, baseSteps: z.array(step), sectors: z.record(sector) }).strict();

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

/** Lo que el esquema no puede ver. Devuelve frases para la pantalla de ajustes. */
function crossCheck(data: QuoterData): string[] {
  const problems: string[] = [];
  const icon = (where: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(QUOTER_ICONS, name)) problems.push(`${where}: no existe el icono «${name}».`);
  };

  if (data.config.rangeLow > data.config.rangeHigh) problems.push('config: rangeLow no puede ser mayor que rangeHigh.');

  const stepIds = data.baseSteps.map((s) => s.id);
  for (const id of duplicates(stepIds)) problems.push(`baseSteps: el paso «${id}» está repetido.`);
  // El motor los busca por su nombre: sin ellos, calcula otra cosa sin avisar.
  for (const needed of ['tipo', 'paginas', 'widgets']) {
    if (!stepIds.includes(needed)) problems.push(`baseSteps: falta el paso «${needed}».`);
  }

  for (const s of data.baseSteps) {
    for (const id of duplicates(s.options.map((o) => o.id))) problems.push(`Paso «${s.id}»: la opción «${id}» está repetida.`);
    for (const o of s.options) icon(`Paso «${s.id}», opción «${o.id}»`, o.icon);
    if (s.id === 'tipo') {
      for (const o of s.options) {
        // tipoFactor multiplica este precio: sin él sale NaN.
        if (typeof o.price !== 'number') problems.push(`Paso «tipo», opción «${o.id}»: necesita precio.`);
      }
    }
  }

  const paginas = data.baseSteps.find((s) => s.id === 'paginas');
  for (const o of paginas?.options ?? []) {
    if (data.config.pageScale[o.id] === undefined) problems.push(`config.pageScale: falta el factor de «${o.id}».`);
  }

  const sectorIds = Object.keys(data.sectors);
  if (sectorIds.length === 0) problems.push('sectors: tiene que haber al menos un sector.');
  for (const [id, sec] of Object.entries(data.sectors)) {
    // El id es el enlace directo (#dental) y va tal cual a la URL.
    if (!/^[a-z0-9-]+$/.test(id)) problems.push(`Sector «${id}»: el id solo admite minúsculas, números y guiones.`);
    icon(`Sector «${id}»`, sec.icon);
    for (const dup of duplicates(sec.widgets.map((w) => w.id))) problems.push(`Sector «${id}»: la pieza «${dup}» está repetida.`);
    for (const w of sec.widgets) icon(`Sector «${id}», pieza «${w.id}»`, w.icon);

    for (const [stepId, p] of Object.entries(sec.patch)) {
      const target = data.baseSteps.find((s) => s.id === stepId);
      if (!target) {
        problems.push(`Sector «${id}»: patch de un paso que no existe («${stepId}»).`);
        continue;
      }
      for (const optId of Object.keys(p.opts ?? {})) {
        if (!target.options.some((o) => o.id === optId)) problems.push(`Sector «${id}», patch «${stepId}»: no existe la opción «${optId}».`);
      }
    }

    const widgetIds = sec.widgets.map((w) => w.id);
    for (const insight of sec.insights) {
      for (const ref of [...insight.when.all, ...insight.when.none]) {
        if (!widgetIds.includes(ref)) problems.push(`Sector «${id}»: una recomendación usa la pieza «${ref}», que no existe.`);
      }
    }
  }
  return problems;
}

export type QuoterValidation = { ok: true; data: QuoterData } | { ok: false; problems: string[] };

export function validateQuoterData(raw: unknown): QuoterValidation {
  const parsed = dataSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 30).map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    };
  }
  const data = parsed.data as QuoterData;
  const problems = crossCheck(data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, data };
}
