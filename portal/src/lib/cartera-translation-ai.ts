import 'server-only';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// Cartera — «Traducir con IA» (decisión B del 19/11/2026, docs/fase1-cartera.md).
//
// La web exige los tres idiomas en cada texto. La agente escribe en español y
// esto PROPONE el inglés y el alemán del título, el resumen, la planta, «lo que
// no tiene» y los textos alternativos de las fotos. Ella los revisa y guarda
// con el botón de siempre: proponer y guardar son dos pasos (CLAUDE.md, «Cuando
// la IA propone algo que el cliente va a confirmar, la ruta no guarda»).
//
// El molde de siempre: fetch directo, nunca lanza, sin clave → skipped, el
// parseo en una función pura y sin valla de markdown. No ve la base de datos
// ni el cliente: recibe textos y devuelve textos. Sin razonamiento en Haiku,
// como site-content-ai.ts: Haiku 5.5 razona por su cuenta y cortaba el JSON.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** Traducciones por hora y cliente (la ruta lo aplica): cada una cuesta dinero, y
 *  una ficha se traduce un par de veces, no treinta. */
export const TRANSLATIONS_PER_HOUR = 30;

export interface TranslationInput {
  title: string;
  summary: string;
  floor: string;
  lacks: string[];
  alts: Array<{ id: string; text: string }>;
}

export type EnDe = { en: string; de: string };

export interface TranslationProposal {
  title: EnDe | null;
  summary: EnDe | null;
  floor: EnDe | null;
  /** Mismo orden y longitud que la entrada; null donde no hay propuesta. */
  lacks: Array<EnDe | null>;
  alts: Array<{ id: string } & EnDe>;
}

export type TranslationResult =
  | { ok: true; proposal: TranslationProposal; model: string }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

function enDe(value: unknown, max: number): EnDe | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const en = clean(o.en);
  const de = clean(o.de);
  return en && de ? { en, de } : null;
}

/** Pura: la respuesta del modelo en propuestas. Solo lo que se pidió (un
 *  campo vacío en español no recibe traducción), «lo que no tiene» en el mismo
 *  orden, y textos alternativos solo de las fotos que se mandaron. */
export function parseTranslationResponse(text: string, input: TranslationInput): TranslationProposal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const lacksIn = Array.isArray(o.lacks) ? o.lacks : [];
  const altsIn = Array.isArray(o.alts) ? o.alts : [];
  const wanted = new Set(input.alts.filter((a) => a.text.trim()).map((a) => a.id));
  const alts: TranslationProposal['alts'] = [];
  for (const a of altsIn) {
    if (!a || typeof a !== 'object') continue;
    const id = (a as Record<string, unknown>).id;
    const t = enDe(a, 300);
    if (typeof id === 'string' && wanted.has(id) && t && !alts.some((x) => x.id === id)) alts.push({ id, ...t });
  }
  return {
    title: input.title.trim() ? enDe(o.title, 200) : null,
    summary: input.summary.trim() ? enDe(o.summary, 2000) : null,
    floor: input.floor.trim() ? enDe(o.floor, 200) : null,
    lacks: input.lacks.map((es, i) => (es.trim() ? enDe(lacksIn[i], 400) : null)),
    alts,
  };
}

/** Nada que traducir: todos los textos en español vacíos. */
export function isEmptyTranslationInput(input: TranslationInput): boolean {
  return ![input.title, input.summary, input.floor, ...input.lacks, ...input.alts.map((a) => a.text)].some((t) => t.trim());
}

function buildSystem(): string {
  return [
    'Traduces la ficha de una casa en venta o alquiler, escrita en español por una agencia inmobiliaria de la costa española, al inglés británico y al alemán.',
    'Reglas:',
    '- Traduce lo que dice, sin añadir ni quitar nada: ni adjetivos de folleto, ni datos que no estén.',
    '- Conserva cifras, medidas (m²), años, nombres de lugares y de calles tal cual.',
    '- El tono es sobrio y concreto, como el original. En alemán, sin tratamiento directo al lector.',
    '- «Lo que no tiene» son defectos reales de la casa: tradúcelos igual de claros, sin suavizarlos.',
    '- Los textos alternativos describen una foto para quien no la ve: frases cortas.',
    '- Responde SOLO con JSON, con esta forma exacta y las mismas posiciones que la entrada:',
    '{"title":{"en":"…","de":"…"},"summary":{"en":"…","de":"…"},"floor":{"en":"…","de":"…"},"lacks":[{"en":"…","de":"…"}],"alts":[{"id":"…","en":"…","de":"…"}]}',
    '- Un campo vacío en la entrada va como null en la respuesta.',
  ].join('\n');
}

function buildUser(input: TranslationInput): string {
  return JSON.stringify(
    {
      title: input.title.trim() || null,
      summary: input.summary.trim() || null,
      floor: input.floor.trim() || null,
      lacks: input.lacks.map((l) => l.trim() || null),
      alts: input.alts.filter((a) => a.text.trim()).map((a) => ({ id: a.id, es: a.text.trim() })),
    },
    null,
    1,
  );
}

export async function translateHomeTexts(input: TranslationInput): Promise<TranslationResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: true, skipped: true, reason: 'no_api_key' };
  // Override solo local: no está en docker-compose.yml (ver CLAUDE.md).
  const model = process.env.ANTHROPIC_CARTERA_TRANSLATION_MODEL || resolved.model || DEFAULT_MODEL;
  const haiku = model.includes('haiku');
  try {
    const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolved.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: haiku ? 4000 : 8000,
        ...(haiku ? { thinking: { type: 'disabled' } } : {}),
        system: buildSystem(),
        messages: [{ role: 'user', content: buildUser(input) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 200)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text;
    if (!text) return { ok: false, error: 'anthropic_api_empty_response' };
    const proposal = parseTranslationResponse(text, input);
    if (!proposal) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, proposal, model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'anthropic_api_error' };
  }
}
