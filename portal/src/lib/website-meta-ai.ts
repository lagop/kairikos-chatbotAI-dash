import 'server-only';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — el título y la descripción para
// Google de cada página de una web de Kairikos, propuestos por la IA.
//
// La auditoría del SEO marca «título corto», «sin descripción»… y con
// WordPress se quedaba en el consejo. Con una web nuestra, el portal SÍ puede
// escribirlos: esto PROPONE, el cliente revisa y aplica con un clic
// (POST /api/portal/seo/website-meta/apply). Proponer y guardar son dos pasos,
// como en la Prospección (Fase A): una propuesta mala no cambia nada sola.
//
// El molde de siempre: fetch directo, nunca lanza, sin clave → skipped, el
// parseo en una función pura y sin valla de markdown. No ve la base de datos:
// recibe el resumen de cada página y devuelve texto.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const META_TITLE_MAX = 60;
export const META_DESCRIPTION_MAX = 155;

export interface WebsiteMetaPageInput {
  ruta: string;
  /** Lo que sale en el menú ('Desatascos en Telde'). */
  titulo: string;
  /** Lo que dice la página, ya en texto: titular, servicios, primeras
   *  frases. Lo arma quien llama. */
  resumen: string;
  metaTituloActual: string;
  metaDescripcionActual: string;
}

export interface WebsiteMetaInput {
  businessName: string;
  city: string | null;
  businessDescription: string | null;
  keywords: string[];
  pages: WebsiteMetaPageInput[];
}

export interface WebsiteMetaProposal {
  ruta: string;
  metaTitulo: string;
  metaDescripcion: string;
}

export type WebsiteMetaResult =
  | { ok: true; proposals: WebsiteMetaProposal[]; model: string }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

/** Pura: la respuesta del modelo en propuestas. Solo rutas que existen,
 *  textos recortados a lo que enseña Google, sin repetir ruta. */
export function parseWebsiteMetaResponse(text: string, rutas: string[]): WebsiteMetaProposal[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { paginas?: unknown }).paginas) ? (raw as { paginas: unknown[] }).paginas : null;
  if (!list) return null;
  const allowed = new Set(rutas);
  const seen = new Set<string>();
  const out: WebsiteMetaProposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const ruta = typeof o.ruta === 'string' ? o.ruta.replace(/^\/+|\/+$/g, '') : null;
    if (ruta === null || !allowed.has(ruta) || seen.has(ruta)) continue;
    const metaTitulo = typeof o.metaTitulo === 'string' ? o.metaTitulo.replace(/\s+/g, ' ').trim().slice(0, META_TITLE_MAX) : '';
    const metaDescripcion = typeof o.metaDescripcion === 'string' ? o.metaDescripcion.replace(/\s+/g, ' ').trim().slice(0, META_DESCRIPTION_MAX) : '';
    if (!metaTitulo && !metaDescripcion) continue;
    seen.add(ruta);
    out.push({ ruta, metaTitulo, metaDescripcion });
  }
  return out;
}

function buildPrompt(input: WebsiteMetaInput): { system: string; user: string } {
  const system = [
    'Escribes el título (<title>) y la meta descripción de cada página de la web de un pequeño negocio local español, para que salga bien en Google.',
    'Reglas:',
    `- Título: como mucho ${META_TITLE_MAX} caracteres. Lo que se busca primero (servicio + zona si la hay), el nombre del negocio al final si cabe. Sin mayúsculas en todas las palabras ni signos de exclamación.`,
    `- Descripción: entre 110 y ${META_DESCRIPTION_MAX} caracteres. Qué ofrece la página y por qué llamar, en español de España, hablando de usted.`,
    '- Solo lo que dice el resumen de la página. Nunca inventes precios, años de experiencia, garantías ni cifras.',
    // Prueba real del 27/10/2026: con la palabra clave «fontanero las palmas»
    // escribió «Fontanero las palmas | …», copiada tal cual en minúsculas.
    '- Usa las palabras clave del negocio cuando encajen de forma natural; no las amontones. Vienen en minúsculas porque así se buscan: tú escribe con la ortografía correcta (los lugares con mayúscula: «Las Palmas»).',
    '- Responde SOLO con JSON: [{"ruta": "...", "metaTitulo": "...", "metaDescripcion": "..."}], una por página, con la ruta tal cual te la doy ("" es la portada).',
  ].join('\n');
  const user = [
    `Negocio: ${input.businessName}${input.city ? ` (${input.city})` : ''}`,
    input.businessDescription ? `Qué hace: ${input.businessDescription.slice(0, 600)}` : null,
    input.keywords.length ? `Palabras clave por las que quiere salir: ${input.keywords.slice(0, 15).join(', ')}` : null,
    '',
    ...input.pages.map((p) =>
      [
        `## Página ruta="${p.ruta}" — «${p.titulo}»`,
        p.metaTituloActual ? `Título actual: ${p.metaTituloActual}` : 'Título actual: (ninguno)',
        p.metaDescripcionActual ? `Descripción actual: ${p.metaDescripcionActual}` : 'Descripción actual: (ninguna)',
        `Contenido: ${p.resumen.slice(0, 1500)}`,
      ].join('\n'),
    ),
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { system, user };
}

export async function proposeWebsiteMeta(input: WebsiteMetaInput): Promise<WebsiteMetaResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: true, skipped: true, reason: 'no_api_key' };
  // Override solo local: no está en docker-compose.yml (ver CLAUDE.md).
  const model = process.env.ANTHROPIC_WEBSITE_META_MODEL || resolved.model || DEFAULT_MODEL;
  const { system, user } = buildPrompt(input);
  try {
    const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolved.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 200)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text;
    if (!text) return { ok: false, error: 'anthropic_api_empty_response' };
    const proposals = parseWebsiteMetaResponse(text, input.pages.map((p) => p.ruta));
    if (!proposals) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, proposals, model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'anthropic_api_error' };
  }
}
