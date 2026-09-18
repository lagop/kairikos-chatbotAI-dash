import 'server-only';
import { parseJsonObject } from './ai-json';
import { logError } from './observability';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// Fase A de Prospección — proponerle al cliente A QUIÉN buscar.
//
// El onboarding eran dos campos de texto libre, "rubro" y "zona", delante de
// alguien que no sabe qué escribir: quien vende reformas no piensa
// "administradores de fincas" hasta que se lo sugieren, y quien escribe
// "empresas" no obtiene nada útil de Google. Esto convierte lo que el cliente
// SÍ sabe decir —qué vende y a quién— en rubros y zonas concretos que él
// confirma o corrige. La última palabra siempre es suya: esto rellena el
// formulario, no lo sustituye.
//
// Mismo molde que lead-classification-ai.ts: fetch directo a la Messages API,
// sin SDK, NUNCA LANZA, degrada con gracia sin clave configurada, y el parseo
// aislado en una función pura para poder probar JSON malformado sin red.
//
// No toca la base de datos ni ve un clientId: recibe texto y devuelve texto.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
/** Con más texto de la web no acierta más: la primera pantalla y el "quiénes
 *  somos" ya dicen a qué se dedica un negocio. Y acota el gasto por llamada. */
export const MAX_WEBSITE_CHARS = 3000;
const MAX_FIELD_CHARS = 120;
const MAX_SUGGESTIONS = 6;

export interface ProspectingBriefInput {
  businessName: string;
  /** Lo que el cliente escribió, o lo que se sacó de su web. Cualquiera de
   *  los tres puede faltar: con solo el nombre y la web ya se propone algo. */
  businessDescription?: string | null;
  idealCustomer?: string | null;
  exclusions?: string | null;
  /** Texto plano de su web, si se pudo rastrear (ver crawlWebsite). */
  websiteText?: string | null;
  /** Para que las zonas propuestas sean de su provincia y no genéricas. */
  knownLocation?: string | null;
}

export interface ProspectingSuggestion {
  /** Rubros tal y como se buscarían en Google: "administradores de fincas",
   *  no "sector inmobiliario". */
  categories: string[];
  locations: string[];
  /** A quién NO buscar, en las palabras del cliente. */
  exclusions: string[];
  /** Una frase que resume el negocio, para que el cliente vea si la IA lo
   *  ha entendido antes de fiarse de lo demás. */
  businessSummary: string | null;
}

export type SuggestProspectingResult =
  | { ok: true; suggestion: ProspectingSuggestion }
  | { ok: true; skipped: true; reason: 'no_api_key' | 'not_enough_context' }
  | { ok: false; error: string };

export async function isProspectingSuggestionConfigured(): Promise<boolean> {
  return (await resolveActiveAnthropicCredentials()) !== null;
}

function clean(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim().slice(0, MAX_FIELD_CHARS);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/** Pura y exportada: se prueba con JSON malformado sin tocar la red. */
export function parseProspectingSuggestion(text: string): ProspectingSuggestion | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const suggestion: ProspectingSuggestion = {
    categories: clean(raw.categories, MAX_SUGGESTIONS),
    locations: clean(raw.locations, MAX_SUGGESTIONS),
    exclusions: clean(raw.exclusions, MAX_SUGGESTIONS),
    businessSummary:
      typeof raw.businessSummary === 'string' && raw.businessSummary.trim()
        ? raw.businessSummary.trim().slice(0, 400)
        : null,
  };
  // Sin un solo rubro no hay nada que enseñar: mejor decir que no se pudo
  // que pintar un formulario vacío como si fuera una propuesta.
  return suggestion.categories.length > 0 ? suggestion : null;
}

function buildSystem(): string {
  return [
    'Eres un consultor de ventas que ayuda a una pyme española a decidir a qué NEGOCIOS ofrecer sus servicios.',
    'Respondes SOLO con un objeto JSON, sin texto alrededor y sin vallas de markdown.',
    'Formato: {"categories": string[], "locations": string[], "exclusions": string[], "businessSummary": string}.',
    '',
    'categories: entre 3 y 6 tipos de negocio a los que este cliente podría venderles, escritos como se buscarían en Google Maps ("administradores de fincas", "talleres de coches"), en español, en plural y sin nombres de empresa.',
    'locations: entre 1 y 4 zonas concretas (municipio, comarca o barrio) coherentes con dónde opera. Si no se sabe dónde está, devuelve una lista vacía en vez de inventar.',
    'exclusions: tipos de negocio que NO encajan y conviene descartar, si se deducen; si no, lista vacía.',
    'businessSummary: una frase de qué hace este negocio y a quién vende.',
    '',
    'No propongas particulares ni consumidores finales: esto busca NEGOCIOS a los que vender.',
    'Si el material no basta para deducirlo, devuelve categories vacío en vez de adivinar.',
  ].join('\n');
}

function buildUserContent(input: ProspectingBriefInput): string {
  const parts = [`Negocio: ${input.businessName}`];
  if (input.businessDescription?.trim()) parts.push(`Qué vende, en sus palabras: ${input.businessDescription.trim()}`);
  if (input.idealCustomer?.trim()) parts.push(`A quién quiere vender: ${input.idealCustomer.trim()}`);
  if (input.exclusions?.trim()) parts.push(`A quién NO quiere: ${input.exclusions.trim()}`);
  if (input.knownLocation?.trim()) parts.push(`Zona donde opera: ${input.knownLocation.trim()}`);
  if (input.websiteText?.trim()) {
    parts.push(`Texto de su web:\n${input.websiteText.trim().slice(0, MAX_WEBSITE_CHARS)}`);
  }
  return parts.join('\n\n');
}

/** Hay contexto suficiente para que la propuesta signifique algo. */
export function hasEnoughContext(input: ProspectingBriefInput): boolean {
  return Boolean(
    input.businessDescription?.trim() || input.idealCustomer?.trim() || input.websiteText?.trim(),
  );
}

export async function suggestProspectingTargets(
  input: ProspectingBriefInput,
): Promise<SuggestProspectingResult> {
  if (!hasEnoughContext(input)) return { ok: true, skipped: true, reason: 'not_enough_context' };

  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: true, skipped: true, reason: 'no_api_key' };

  const model = process.env.ANTHROPIC_PROSPECTING_BRIEF_MODEL ?? resolved.model;
  try {
    const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': resolved.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: buildSystem(),
        messages: [{ role: 'user', content: buildUserContent(input) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((block) => block.type === 'text')?.text?.trim();
    if (!text) return { ok: false, error: 'anthropic_api_empty_response' };
    const suggestion = parseProspectingSuggestion(text);
    if (!suggestion) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, suggestion };
  } catch (err) {
    logError('prospecting_brief_ai.suggest', err, { route: 'lib/prospecting-brief-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
