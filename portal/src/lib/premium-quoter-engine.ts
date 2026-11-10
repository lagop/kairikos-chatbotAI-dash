// =============================================================================
// Presupuestador de Kairikos Web Premium — el motor (09/11/2026).
//
// Puro y sin 'server-only' a propósito: lo ejecutan el navegador, para enseñar
// el precio mientras se contesta, y la ruta pública, que lo vuelve a calcular
// al recibir el formulario. Es la misma función en los dos lados, así que lo
// que ve el visitante y lo que llega a la bandeja no pueden diferir.
//
// `compute()` y sus ayudantes son una traducción literal del prototipo
// (docs/kairikos-web-premium-presupuestador/presupuestador-multisector.html),
// incluidos sus redondeos. Se comparó con el original en todas las respuestas
// posibles antes de darlo por bueno. Si hay que cambiar una fórmula, es una
// decisión de negocio: no la «arregles» de paso.
//
// Dos cosas que el prototipo llevaba escritas en el código y aquí son datos:
//
//   - Los precios de los servicios de Kairikos. Una opción dice `catalog` y
//     `resolveQuoter` le pone el importe del catálogo público, el mismo de
//     /planes/. Los importes dentro de una frase van como
//     {chatbot.starter.mes}. Si falta alguno, resolver FALLA en vez de enseñar
//     un precio inventado: un presupuestador caído se ve, un precio falso no.
//
//   - Las recomendaciones finales eran funciones (`a => a.w.includes('x')`).
//     Una función no se puede guardar en una base de datos ni editar en una
//     pantalla, así que son condiciones: `when: { all: [...], none: [...] }`.
// =============================================================================

export type CatalogRef =
  | { code: string; tier: string; minusTier?: string; addon?: undefined }
  | { code: string; addon: string; tier?: undefined; minusTier?: undefined };

export interface QuoterOption {
  id: string;
  icon: string;
  label: string;
  desc: string;
  /** Pago único, en euros. */
  price?: number;
  /** Euros al mes. */
  monthly?: number;
  /** Semanas que suma al plazo. */
  weeks?: number;
  /** Multiplicador global del precio. */
  mult?: number;
  /** Multiplicador global del plazo. */
  weeksMult?: number;
  /** El precio crece con el número de páginas. */
  scale?: boolean;
  /** Parte que no escala (p. ej. producción de foto y vídeo). */
  fixed?: number;
  tag?: string;
  /** Solo en el paso de sector: lo que se enseña en lugar del precio. */
  note?: string;
  /** Solo en los datos: de dónde sale el importe. Resuelto ya no está. */
  catalog?: CatalogRef;
}

export interface QuoterStep {
  id: string;
  kicker: string;
  title: string;
  sub: string;
  type: 'single' | 'multi';
  optional?: boolean;
  sector?: boolean;
  options: QuoterOption[];
}

export interface QuoterStepPatch {
  title?: string;
  sub?: string;
  opts?: Record<string, Partial<QuoterOption>>;
}

export interface QuoterInsight {
  when: { all: string[]; none: string[] };
  text: string;
}

export interface QuoterHero {
  h1: string;
  p: string;
}

export interface QuoterSector {
  name: string;
  icon: string;
  blurb: string;
  ticket: string;
  tipoFactor?: number;
  hero: QuoterHero;
  patch: Record<string, QuoterStepPatch>;
  widgets: QuoterOption[];
  insights: QuoterInsight[];
}

export interface QuoterConfig {
  /** Si la página se puede ver. Nace apagada. */
  published: boolean;
  currency: string;
  rangeLow: number;
  rangeHigh: number;
  baseWeeks: number;
  /** spotsLeft ya no se muestra (11/11/2026); ver premium-quoter-schema.ts. */
  launch: { enabled: boolean; discount: number; spotsLeft?: number; label: string };
  /** 0 = no se ofrecen cuotas. */
  installments: number;
  included: string[];
  pageScale: Record<string, number>;
  ivaNote: string;
  defaultHero: QuoterHero;
  /** Número real de clientes y valoración. Null: el bloque no se pinta. */
  socialProof: string | null;
  /** La línea de la pantalla de gracias. */
  thanksText: string;
}

export interface QuoterData {
  config: QuoterConfig;
  baseSteps: QuoterStep[];
  sectors: Record<string, QuoterSector>;
}

/** Lo mínimo del catálogo público que hace falta aquí. */
export interface QuoterCatalog {
  products: {
    code: string;
    tiers: { tier: string; priceCents: number; setupFeeCents: number }[];
    addons: { code: string; priceCents: number }[];
  }[];
}

export type QuoterAnswers = Record<string, string | string[]>;

export interface QuoterSelection {
  sector: string | null;
  answers: QuoterAnswers;
}

export interface QuoterEstimate {
  list: number;
  total: number;
  perMonth: number;
  low: number;
  high: number;
  monthly: number;
  weeks: number;
  lines: [string, string][];
}

// --- Del catálogo a los datos ------------------------------------------------

const AMOUNT_TOKEN = /\{([a-z_]+)\.([a-z_]+)\.(mes|alta)\}/g;

function euros(cents: number): number {
  return cents / 100;
}

function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function applyCatalog(option: QuoterOption, catalog: QuoterCatalog, missing: string[]): QuoterOption {
  const { catalog: ref, ...rest } = option;
  if (!ref) return rest;
  const product = catalog.products.find((p) => p.code === ref.code);
  if (ref.addon !== undefined) {
    const addon = product?.addons.find((a) => a.code === ref.addon);
    if (!addon) {
      missing.push(`${ref.code}/${ref.addon}`);
      return rest;
    }
    return { ...rest, price: 0, monthly: euros(addon.priceCents) };
  }
  const tier = product?.tiers.find((t) => t.tier === ref.tier);
  if (!tier) {
    missing.push(`${ref.code}/${ref.tier}`);
    return rest;
  }
  if (ref.minusTier === undefined) {
    return { ...rest, price: euros(tier.setupFeeCents), monthly: euros(tier.priceCents) };
  }
  // Ampliar de un escalón a otro: la diferencia de cuota y ninguna alta, porque
  // el escalón de partida ya va incluido en la web.
  const base = product?.tiers.find((t) => t.tier === ref.minusTier);
  if (!base) {
    missing.push(`${ref.code}/${ref.minusTier}`);
    return rest;
  }
  return { ...rest, price: 0, monthly: euros(tier.priceCents - base.priceCents) };
}

function fillAmounts<T>(value: T, catalog: QuoterCatalog, missing: string[]): T {
  if (typeof value === 'string') {
    return value.replace(AMOUNT_TOKEN, (token, code: string, tierCode: string, field: string) => {
      const tier = catalog.products.find((p) => p.code === code)?.tiers.find((t) => t.tier === tierCode);
      if (!tier) {
        missing.push(token);
        return token;
      }
      return thousands(euros(field === 'mes' ? tier.priceCents : tier.setupFeeCents));
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillAmounts(v, catalog, missing)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillAmounts(v, catalog, missing)])) as T;
  }
  return value;
}

export type ResolveResult = { ok: true; quoter: QuoterData } | { ok: false; missing: string[] };

/** Pone los importes del catálogo. Falla, y dice cuáles, si falta alguno. */
export function resolveQuoter(data: QuoterData, catalog: QuoterCatalog): ResolveResult {
  const missing: string[] = [];
  const withPrices: QuoterData = {
    config: data.config,
    baseSteps: data.baseSteps.map((s) => ({ ...s, options: s.options.map((o) => applyCatalog(o, catalog, missing)) })),
    sectors: Object.fromEntries(
      Object.entries(data.sectors).map(([id, s]) => [
        id,
        { ...s, widgets: s.widgets.map((o) => applyCatalog(o, catalog, missing)) },
      ]),
    ),
  };
  const quoter = fillAmounts(withPrices, catalog, missing);
  if (missing.length > 0) return { ok: false, missing: [...new Set(missing)] };
  return { ok: true, quoter };
}

// --- El motor, tal y como estaba en el prototipo ------------------------------

export const round50 = (n: number): number => Math.round(n / 50) * 50;

export function fmt(q: QuoterData, n: number): string {
  return `${thousands(n)} ${q.config.currency}`;
}

function pageFactor(q: QuoterData, answers: QuoterAnswers): number {
  return q.config.pageScale[answers.paginas as string] || 1;
}

function cost(q: QuoterData, answers: QuoterAnswers, o: QuoterOption): number {
  return o.scale ? round50((o.price || 0) * pageFactor(q, answers) + (o.fixed || 0)) : o.price || 0;
}

export function sectorStep(q: QuoterData): QuoterStep {
  return {
    id: 'sector',
    kicker: 'Tu sector',
    title: '¿A qué se dedica tu negocio?',
    sub: 'Adaptamos las preguntas y las piezas premium a tu sector.',
    type: 'single',
    sector: true,
    options: Object.entries(q.sectors).map(([id, s]) => ({ id, icon: s.icon, label: s.name, desc: s.blurb, note: s.ticket })),
  };
}

export function buildSteps(q: QuoterData, sectorId: string | null): QuoterStep[] {
  const first = sectorStep(q);
  const sec = sectorId ? q.sectors[sectorId] : undefined;
  if (!sec) return [first];
  const list = q.baseSteps.map((b) => {
    const p = sec.patch[b.id] || {};
    const st: QuoterStep = { ...b, title: p.title || b.title, sub: p.sub || b.sub };
    st.options = b.id === 'widgets' ? sec.widgets : b.options.map((o) => ({ ...o, ...((p.opts || {})[o.id] || {}) }));
    if (b.id === 'tipo' && sec.tipoFactor) {
      const factor = sec.tipoFactor;
      st.options = st.options.map((o) => ({ ...o, price: round50((o.price as number) * factor) }));
    }
    return st;
  });
  return [first, ...list];
}

export function selectedOptions(step: QuoterStep, answers: QuoterAnswers): QuoterOption[] {
  const a = answers[step.id];
  if (step.type === 'multi') return step.options.filter((o) => Array.isArray(a) && a.includes(o.id));
  return step.options.filter((o) => o.id === a);
}

export function compute(q: QuoterData, { sector, answers }: QuoterSelection): QuoterEstimate {
  let once = 0;
  let monthly = 0;
  let mult = 1;
  let weeks = q.config.baseWeeks;
  let weeksMult = 1;
  const lines: [string, string][] = [];
  buildSteps(q, sector).forEach((s) => {
    if (s.sector) return;
    selectedOptions(s, answers).forEach((o) => {
      once += cost(q, answers, o);
      monthly += o.monthly || 0;
      weeks += o.weeks || 0;
      if (o.mult) mult *= o.mult;
      if (o.weeksMult) weeksMult *= o.weeksMult;
      if (o.price) lines.push([o.label, fmt(q, cost(q, answers, o))]);
      if (o.monthly) lines.push([o.label, `${fmt(q, o.monthly)}/mes`]);
      if (o.mult && o.mult !== 1) lines.push([o.label, `${o.mult > 1 ? '+' : '−'}${Math.round(Math.abs(o.mult - 1) * 100)} %`]);
    });
  });
  const list = once * mult;
  const L = q.config.launch;
  const total = round50(L.enabled ? list * (1 - L.discount) : list);
  return {
    list,
    total,
    perMonth: q.config.installments > 0 ? Math.ceil(total / q.config.installments / 5) * 5 : 0,
    low: round50(total * q.config.rangeLow),
    high: round50(total * q.config.rangeHigh),
    monthly,
    weeks: Math.max(1, Math.round(weeks * weeksMult)),
    lines,
  };
}

export function priceText(q: QuoterData, answers: QuoterAnswers, o: QuoterOption): string {
  if (o.note) return o.note;
  if (o.price) return `+${fmt(q, cost(q, answers, o))}${o.monthly ? ` · ${fmt(q, o.monthly)}/mes` : ''}`;
  if (o.monthly) return `${fmt(q, o.monthly)}/mes`;
  if (o.mult && o.mult !== 1) return `${o.mult > 1 ? '+' : '−'}${Math.round(Math.abs(o.mult - 1) * 100)} %`;
  return 'Incluido';
}

export function insightFor(q: QuoterData, { sector, answers }: QuoterSelection): string {
  const sec = sector ? q.sectors[sector] : undefined;
  const w = Array.isArray(answers.widgets) ? answers.widgets : [];
  if (!w.length) {
    return '<b>Sugerencia:</b> las piezas premium son lo que convierte una web bonita en una web que vende. En la llamada vemos cuáles tienen más impacto en tu caso.';
  }
  const hit = (sec?.insights || []).find((x) => x.when.all.every((id) => w.includes(id)) && x.when.none.every((id) => !w.includes(id)));
  if (hit) return hit.text;
  if (answers.idiomas && answers.idiomas !== 'i1') {
    return '<b>Bien visto:</b> una web multilingüe bien hecha es un argumento de captación propio con clientela internacional.';
  }
  return '<b>Buen punto de partida:</b> en la llamada priorizamos las piezas según tus servicios más rentables.';
}

export type AnswersCheck = { ok: true; answers: QuoterAnswers } | { ok: false; step: string };

/**
 * Comprueba las respuestas que llegan del navegador contra las opciones del
 * sector y devuelve solo las conocidas. Un id inventado no puede colarse en la
 * bandeja, y un paso obligatorio sin contestar no llega a presupuestarse.
 */
export function checkAnswers(q: QuoterData, sector: string, raw: Record<string, unknown>): AnswersCheck {
  if (!Object.prototype.hasOwnProperty.call(q.sectors, sector)) return { ok: false, step: 'sector' };
  const answers: QuoterAnswers = { sector };
  for (const step of buildSteps(q, sector)) {
    if (step.sector) continue;
    const value = raw[step.id];
    const known = new Set(step.options.map((o) => o.id));
    if (step.type === 'multi') {
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !known.has(v))) return { ok: false, step: step.id };
      answers[step.id] = [...new Set(value as string[])];
    } else {
      if (value === undefined && step.optional) continue;
      if (typeof value !== 'string' || !known.has(value)) return { ok: false, step: step.id };
      answers[step.id] = value;
    }
  }
  return { ok: true, answers };
}

// --- Consentimiento y franjas -------------------------------------------------

/**
 * El texto de la casilla, con su versión. Si cambias el texto, cambia la
 * versión: cada solicitud guarda la que aceptó, y eso es lo que se enseña si
 * alguien pregunta qué aceptó esa persona y cuándo. Por eso está en código y
 * no en los datos editables.
 */
export const QUOTER_CONSENT = {
  version: '2026-11-09',
  text: 'Acepto la política de privacidad y que me contactéis sobre este presupuesto.',
  linkText: 'política de privacidad',
  privacyUrl: 'https://kairikos.com/privacidad/',
} as const;

export const QUOTER_CALL_SLOTS = ['Mañana (9–13 h)', 'Mediodía (13–16 h)', 'Tarde (16–19 h)'] as const;
