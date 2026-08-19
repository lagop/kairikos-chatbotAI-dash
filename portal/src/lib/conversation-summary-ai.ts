import 'server-only';
import { logError } from './observability';

// =============================================================================
// Canales Fase 7 — resume, para el dueño del negocio, la actividad del
// chatbot en una ventana de tiempo. Mismo patrón que review-reply-ai.ts
// (primer y hasta ahora único integrador de IA de este portal): fetch
// directo a la Messages API de Anthropic, sin SDK, nunca lanza, degrada
// con gracia si falta la API key.
//
// A diferencia de review-reply-ai.ts (que devuelve texto libre), acá se
// le pide al modelo un JSON estricto — el resultado alimenta dos campos
// separados en ConversationDigest (summaryText, highlights) y parsear
// texto libre para separarlos sería frágil. parseDigestResponse aísla
// ese parseo para poder testear los casos de JSON malformado sin pegarle
// a la red.
// =============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONVERSATIONS_IN_PROMPT = 40;
const MAX_TRANSCRIPT_CHARS = 800;
const MAX_SUMMARY_CHARS = 800;
const MAX_HIGHLIGHTS = 8;
const MAX_HIGHLIGHT_CHARS = 300;

export function isConversationSummaryAIConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface DigestConversationInput {
  startedAt: Date;
  outcome: string | null;
  duration: number | null;
  transcript: unknown;
}

export interface GenerateConversationDigestInput {
  businessName: string;
  conversations: DigestConversationInput[];
}

export type GenerateConversationDigestResult =
  | { ok: true; summaryText: string; highlights: string[] }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

/** Best-effort extraction of readable text from a free-form transcript
 *  Json blob (schema.prisma: "message list, metadata, tool calls, etc.")
 *  — never throws, degrades to a truncated JSON dump when the shape is
 *  unexpected. */
function extractTranscriptText(transcript: unknown): string {
  if (transcript === null || transcript === undefined) return '(sin transcript)';
  try {
    if (Array.isArray(transcript)) {
      const lines = transcript.map((entry) => {
        if (entry && typeof entry === 'object') {
          const role = 'role' in entry ? String((entry as Record<string, unknown>).role) : 'msg';
          const content = 'content' in entry ? (entry as Record<string, unknown>).content : entry;
          return `${role}: ${typeof content === 'string' ? content : JSON.stringify(content)}`;
        }
        return String(entry);
      });
      return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
    }
    return JSON.stringify(transcript).slice(0, MAX_TRANSCRIPT_CHARS);
  } catch {
    return '(transcript no legible)';
  }
}

function buildUserContent(input: GenerateConversationDigestInput): string {
  const sample = input.conversations.slice(0, MAX_CONVERSATIONS_IN_PROMPT);
  const omitted = input.conversations.length - sample.length;
  const entries = sample.map((c, i) => {
    const when = c.startedAt.toISOString();
    const outcome = c.outcome ?? 'unknown';
    const durationLabel = c.duration != null ? `${c.duration}s` : 'desconocida';
    return [
      `Conversación ${i + 1} — ${when}, resultado: ${outcome}, duración: ${durationLabel}`,
      extractTranscriptText(c.transcript),
    ].join('\n');
  });
  const lines = [
    `Negocio: ${input.businessName}`,
    `Total de conversaciones en esta ventana: ${input.conversations.length}.`,
    omitted > 0 ? `(Se muestran las primeras ${sample.length}; hay ${omitted} más no incluidas por espacio.)` : null,
    '',
    ...entries,
  ].filter((line): line is string => line !== null);
  return lines.join('\n\n');
}

interface ParsedDigest {
  summaryText: string;
  highlights: string[];
}

/** Isolated so malformed-JSON handling can be tested without a fetch mock. */
export function parseDigestResponse(text: string): ParsedDigest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summaryText !== 'string') return null;
  const highlightsRaw = Array.isArray(obj.highlights) ? obj.highlights : [];
  const highlights = highlightsRaw
    .filter((h): h is string => typeof h === 'string')
    .slice(0, MAX_HIGHLIGHTS)
    .map((h) => h.slice(0, MAX_HIGHLIGHT_CHARS));
  return { summaryText: obj.summaryText.slice(0, MAX_SUMMARY_CHARS), highlights };
}

export async function generateConversationDigest(
  input: GenerateConversationDigestInput,
): Promise<GenerateConversationDigestResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }

  const model = process.env.ANTHROPIC_CONVERSATION_DIGEST_MODEL ?? DEFAULT_MODEL;
  const system = [
    `Resumes, para el dueño de "${input.businessName}", la actividad de su chatbot en una ventana de tiempo.`,
    'Reglas estrictas:',
    '- Responde SOLO con un objeto JSON válido, sin texto antes ni después: {"summaryText": string, "highlights": string[]}.',
    '- summaryText: 2 a 4 frases en español, tono directo y sin tecnicismos, describiendo qué pasó en general.',
    '- highlights: lista de solicitudes concretas que el negocio debería atender (ej. "Un cliente preguntó por una reserva para 8 personas el sábado y no se le confirmó"), máximo 8 elementos, cada uno una frase corta.',
    '- Si ninguna conversación requiere atención, highlights debe ser una lista vacía.',
    '- Nunca inventes datos que no estén en las conversaciones.',
  ].join('\n');

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: buildUserContent(input) }],
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
    const parsed = parseDigestResponse(text);
    if (!parsed) {
      return { ok: false, error: 'anthropic_api_invalid_json' };
    }
    return { ok: true, summaryText: parsed.summaryText, highlights: parsed.highlights };
  } catch (err) {
    logError('conversation_summary_ai.generate_digest', err, { route: 'lib/conversation-summary-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
