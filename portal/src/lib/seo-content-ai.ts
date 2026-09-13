import 'server-only';
import { parseJsonObject } from './ai-json';
import { logError } from './observability';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// Fase 1.3 — el redactor de artículos.
//
// Antes, seo-content-generation.ts reunía las señales y empujaba un evento
// `seo_content` a n8n, esperando que alguien devolviera el artículo por
// PATCH /api/internal/seo/content-drafts/[id]. Ese workflow no existía: el
// producto cobraba 199 €/mes por medir y publicar, pero nadie escribía.
// Aquí se escribe, con el mismo molde que el resto de integraciones de IA
// del portal (review-reply-ai.ts, lead-classification-ai.ts,
// chatbot-reply-ai.ts): fetch directo, nunca lanza, degrada sin clave, y
// el parseo aislado para poder testearlo sin red.
//
// La ruta del callback sigue existiendo y funcionando: si algún día vuelve
// a haber una fuente externa, no hay que reconstruir nada. Simplemente ya
// no es el camino principal.
//
// El formato de salida no es una decisión libre: lo fija el otro extremo.
// SeoContentDraft guarda `bodyHtml` y wordpress-publish.ts lo manda tal
// cual como `content` del post, así que el modelo escribe HTML de cuerpo
// —sin <html>, sin <h1>, que WordPress ya pone el título como encabezado
// principal— y no Markdown.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';

const MAX_TITLE_CHARS = 300;
const MAX_META_CHARS = 500;
const MAX_KEYWORD_CHARS = 200;
const MAX_BODY_CHARS = 200_000;
/** Cuántas consultas de oportunidad viajan al prompt. seo-content-generation
 *  ya las trae ordenadas por impresiones, así que las primeras son las de
 *  más alcance. */
const MAX_OPPORTUNITIES_IN_PROMPT = 10;

export async function isSeoContentAIConfigured(): Promise<boolean> {
  return (await resolveActiveAnthropicCredentials()) !== null;
}

export interface QueryOpportunity {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface GenerateArticleInput {
  businessName: string;
  businessDescription: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  siteUrl: string | null;
  /** SeoAuditResult ya guardado (títulos, meta, encabezados…), tal cual. */
  siteAudit: unknown;
  queryOpportunities: QueryOpportunity[];
}

export interface ArticleDraft {
  title: string;
  metaDescription: string;
  targetKeyword: string;
  bodyHtml: string;
}

export type GenerateArticleResult =
  | ({ ok: true } & ArticleDraft)
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

function buildSystemPrompt(input: GenerateArticleInput): string {
  const opportunities = input.queryOpportunities.slice(0, MAX_OPPORTUNITIES_IN_PROMPT);

  return [
    `Escribes un artículo para el blog de "${input.businessName}", un negocio pequeño. El objetivo es que ese artículo posicione en Google y traiga clientes reales, no tráfico suelto.`,
    '',
    'CONTEXTO DEL NEGOCIO (lo escribió el propio negocio en su alta):',
    `- Descripción: ${input.businessDescription ?? '(no la ha dado)'}`,
    `- A quién se dirige: ${input.targetAudience ?? '(no lo ha dicho)'}`,
    `- Tono que quiere: ${input.toneOfVoice ?? '(no lo ha dicho; usa un tono claro y cercano)'}`,
    `- Su web: ${input.siteUrl ?? '(no la ha dado)'}`,
    '',
    opportunities.length > 0
      ? [
          'CONSULTAS REALES POR LAS QUE SU WEB YA APARECE, sin llegar a posicionar (datos de Search Console):',
          ...opportunities.map(
            (o) => `- "${o.query}" — posición media ${o.position}, ${o.impressions} impresiones, ${o.clicks} clics`,
          ),
          '',
          'Elige UNA de esas consultas como objetivo del artículo: son búsquedas por las que Google ya considera relevante a esta web, así que son las que un artículo puede mover de verdad. Prefiere la que combine muchas impresiones con pocos clics.',
        ].join('\n')
      : 'No hay todavía datos de Search Console: elige tú un tema útil y buscable a partir de la descripción del negocio y de su público.',
    '',
    'REGLAS:',
    '- Escribe en español, en el tono indicado, dirigiéndote al público descrito.',
    '- Entre 700 y 1000 palabras. Frases cortas, sin relleno ni introducciones vacías.',
    '- La consulta objetivo debe aparecer de forma natural en el título, en el primer párrafo y en algún subtítulo. Nada de repetirla forzadamente.',
    '- NUNCA inventes datos del negocio: ni precios, ni años de experiencia, ni número de clientes, ni certificaciones, ni ubicaciones que no estén en el contexto de arriba. Si hace falta un dato que no tienes, escribe alrededor de él.',
    '- Nada de estadísticas o estudios inventados. Si no puedes citar la fuente, no des la cifra.',
    '- Termina con una llamada a la acción sobria y coherente con lo que hace el negocio.',
    '',
    'FORMATO DEL CUERPO — HTML de cuerpo para WordPress:',
    '- Usa solo <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong> y <em>.',
    '- NO incluyas <h1> (WordPress ya pinta el título), ni <html>, <head>, <body>, ni estilos, ni scripts, ni imágenes.',
    '',
    'SALIDA — responde SOLO con un objeto JSON válido, sin texto antes ni después:',
    '{"title": string, "metaDescription": string, "targetKeyword": string, "bodyHtml": string}',
    '- `title`: máximo 60 caracteres, sin comillas alrededor.',
    '- `metaDescription`: máximo 155 caracteres, que invite a hacer clic.',
    '- `targetKeyword`: la consulta que has elegido, tal cual.',
  ].join('\n');
}

/** Aislada para poder testear JSON malformado o incompleto sin red — mismo
 *  papel que parseLeadClassificationResponse y parseBotReplyResponse. */
export function parseArticleResponse(text: string): ArticleDraft | null {
  const obj = parseJsonObject(text);
  if (obj === null) return null;

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  const title = str(obj.title);
  const bodyHtml = str(obj.bodyHtml);
  const targetKeyword = str(obj.targetKeyword);
  const metaDescription = str(obj.metaDescription);

  // title y bodyHtml son obligatorios en el contrato del draft (ver la ruta
  // del callback): sin ellos no hay artículo que revisar.
  if (!title || !bodyHtml) return null;

  return {
    title: title.slice(0, MAX_TITLE_CHARS),
    bodyHtml: bodyHtml.slice(0, MAX_BODY_CHARS),
    targetKeyword: (targetKeyword ?? '').slice(0, MAX_KEYWORD_CHARS),
    metaDescription: (metaDescription ?? '').slice(0, MAX_META_CHARS),
  };
}

export async function generateArticleDraft(input: GenerateArticleInput): Promise<GenerateArticleResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }
  const { apiKey, baseUrl } = resolved;

  const model = process.env.ANTHROPIC_SEO_CONTENT_MODEL ?? resolved.model;

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        // Un artículo de ~1000 palabras en HTML, dentro de un JSON.
        max_tokens: 6000,
        system: buildSystemPrompt(input),
        messages: [
          {
            role: 'user',
            content: `Escribe el artículo para "${input.businessName}". Incluye el audit técnico de su web solo como contexto de qué le falta al sitio, no como tema del artículo: ${JSON.stringify(input.siteAudit ?? null)}`,
          },
          // Prefill: fuerza que la respuesta sea el objeto JSON y no una
          // introducción en prosa. Misma técnica que chatbot-reply-ai.ts,
          // donde se descubrió que hacía falta.
          { role: 'assistant', content: '{' },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((block) => block.type === 'text')?.text?.trim();
    if (!text) {
      return { ok: false, error: 'anthropic_api_empty_response' };
    }
    const parsed = parseArticleResponse(text.startsWith('{') || text.startsWith('```') ? text : `{${text}`);
    if (!parsed) {
      return { ok: false, error: 'anthropic_api_invalid_json' };
    }
    return { ok: true, ...parsed };
  } catch (err) {
    logError('seo_content_ai.generate', err, { route: 'lib/seo-content-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
