import 'server-only';
import { parseJsonObject } from './ai-json';
import { logError } from './observability';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// "Sistema IA de captación" — decide si una ChatbotConversation cerrada es
// un lead y, si lo es, la puntúa. Mismo patrón que conversation-summary-ai.ts
// (fetch directo a la Messages API de Anthropic, sin SDK, nunca lanza,
// degrada con gracia si falta la API key, parseo aislado y testeable sin
// red) — segundo integrador de IA de este portal después de
// review-reply-ai.ts/conversation-summary-ai.ts.
//
// A diferencia de esos dos, el resultado alimenta directamente Lead
// (score/scoreReason/contactName/contactPhone/contactEmail/summary), así
// que el contrato de salida sigue esos mismos nombres de campo — el
// caller (lib/leads.ts's ingestClassifiedLead) los pasa sin remapear.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_SCORE_REASON_CHARS = 2000;
const MAX_SUMMARY_CHARS = 2000;
const MAX_FIELD_CHARS = 200;

export async function isLeadClassificationConfigured(): Promise<boolean> {
  return (await resolveActiveAnthropicCredentials()) !== null;
}

export interface LeadQualificationInput {
  perfilClienteIdeal: string | null;
  senalesDescarte: string | null;
}

/** Fase 2.3 — un lead que el propio cliente ya cerró, con el veredicto que
 *  le dio. Son los ejemplos con los que aprende el clasificador. */
export interface ClassifiedExample {
  summary: string;
  /** true si el cliente lo marcó 'convertido'; false si 'descartado'. */
  converted: boolean;
}

export interface ClassifyConversationInput {
  businessName: string;
  qualification: LeadQualificationInput | null;
  outcome: string | null;
  transcript: unknown;
  /** Histórico real de este cliente. Vacío mientras no haya cerrado
   *  ninguno, que es el estado normal de un cliente nuevo. */
  examples?: ClassifiedExample[];
}

export interface LeadClassificationResult {
  isLead: boolean;
  score: number;
  scoreReason: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  summary: string | null;
}

export type ClassifyConversationResult =
  | ({ ok: true } & LeadClassificationResult)
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

/** Best-effort extraction of readable text from a free-form transcript
 *  Json blob (schema.prisma: "message list, metadata, tool calls, etc.")
 *  — never throws, degrades to a truncated JSON dump when the shape is
 *  unexpected. Same reasoning as conversation-summary-ai.ts's own
 *  extractTranscriptText, duplicated rather than imported since that
 *  file has no exported helpers and this one uses a different char cap
 *  (a single conversation gets far more budget than one of up to 40 in
 *  a digest prompt). */
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

function buildUserContent(input: ClassifyConversationInput): string {
  const lines = [
    `Negocio: ${input.businessName}`,
    `Resultado de la conversación: ${input.outcome ?? 'desconocido'}`,
    '',
    'Transcript:',
    extractTranscriptText(input.transcript),
  ];
  return lines.join('\n');
}

function buildSystem(input: ClassifyConversationInput): string {
  const qualificationBlock = input.qualification?.perfilClienteIdeal
    ? [
        `Perfil de cliente ideal para "${input.businessName}": ${input.qualification.perfilClienteIdeal}`,
        input.qualification.senalesDescarte
          ? `Señales que DESCALIFICAN a un contacto: ${input.qualification.senalesDescarte}`
          : null,
      ].filter((line): line is string => line !== null).join('\n')
    : `"${input.businessName}" no ha descrito todavía a su cliente ideal — evalúa con criterio genérico: interés real de compra, datos de contacto dados, urgencia expresada.`;

  // Fase 2.3 — el histórico del propio cliente. No es reentrenamiento: son
  // ejemplos reales de lo que ESTE negocio acabó cerrando o descartando,
  // que es la señal más honesta de qué le sirve. Sin histórico, el bloque
  // desaparece y el prompt queda como estaba.
  const examples = input.examples ?? [];
  const examplesBlock =
    examples.length > 0
      ? [
          '',
          `Así ha ido con contactos anteriores de "${input.businessName}" (lo decidió el propio negocio, no tú):`,
          ...examples.map(
            (e) => `- ${e.converted ? 'SE CONVIRTIÓ en cliente' : 'NO llegó a nada'}: ${e.summary}`,
          ),
          'Úsalo para calibrar la puntuación: si este contacto se parece a los que se convirtieron, sube; si se parece a los descartados, baja.',
        ].join('\n')
      : '';

  return [
    `Analizas una conversación cerrada del chatbot de "${input.businessName}" para decidir si el contacto es un lead comercial real y, si lo es, priorizarlo.`,
    '',
    qualificationBlock,
    examplesBlock,
    '',
    'Reglas estrictas:',
    '- Responde SOLO con un objeto JSON válido, sin texto antes ni después:',
    '  {"isLead": boolean, "score": number, "scoreReason": string, "contactName": string|null, "contactPhone": string|null, "contactEmail": string|null, "summary": string|null}',
    '- isLead: true solo si hay interés comercial real (pregunta por precio, disponibilidad, quiere una cita/servicio) — una consulta genérica, un saludo, o alguien buscando empleo/soporte NO es un lead.',
    '- score: 0-100, qué tan probable es que este contacto se convierta en cliente. Si el negocio dio señales de descarte y el contacto las cumple, score bajo (0-20) aunque isLead sea true.',
    '- scoreReason: una frase corta en español explicando el número — esto lo ve el dueño del negocio, nunca inventes datos que no estén en la conversación.',
    '- contactName/contactPhone/contactEmail: solo si aparecen explícitamente en la conversación, si no null. Nunca inventados.',
    '- summary: 1-2 frases de qué pidió el contacto. null si isLead es false.',
    '- Si isLead es false, score debe ser 0 y summary debe ser null — igualmente da un scoreReason breve.',
  ].join('\n');
}

/** Isolated so malformed-JSON / missing-field handling can be tested
 *  without a fetch mock — same role as conversation-summary-ai.ts's
 *  parseDigestResponse.
 *
 * El desenvuelto de la valla ```json vive en ai-json.ts — se encontró aquí
 * primero (falló el 100% de un barrido real) y ahora lo comparte también
 * chatbot-reply-ai.ts. */
export function parseLeadClassificationResponse(text: string): LeadClassificationResult | null {
  const obj = parseJsonObject(text);
  if (obj === null) return null;
  if (typeof obj.isLead !== 'boolean') return null;
  if (typeof obj.scoreReason !== 'string') return null;

  const scoreRaw = typeof obj.score === 'number' ? obj.score : 0;
  const score = Math.min(100, Math.max(0, Math.round(scoreRaw)));

  const strOrNull = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;

  return {
    isLead: obj.isLead,
    score: obj.isLead ? score : 0,
    scoreReason: obj.scoreReason.slice(0, MAX_SCORE_REASON_CHARS),
    contactName: strOrNull(obj.contactName, MAX_FIELD_CHARS),
    contactPhone: strOrNull(obj.contactPhone, MAX_FIELD_CHARS),
    contactEmail: strOrNull(obj.contactEmail, MAX_FIELD_CHARS),
    summary: obj.isLead ? strOrNull(obj.summary, MAX_SUMMARY_CHARS) : null,
  };
}

export async function classifyConversationForLead(
  input: ClassifyConversationInput,
): Promise<ClassifyConversationResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }
  const { apiKey, baseUrl } = resolved;

  const model = process.env.ANTHROPIC_LEAD_CLASSIFICATION_MODEL ?? resolved.model;

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
        max_tokens: 512,
        system: buildSystem(input),
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
    const parsed = parseLeadClassificationResponse(text);
    if (!parsed) {
      return { ok: false, error: 'anthropic_api_invalid_json' };
    }
    return { ok: true, ...parsed };
  } catch (err) {
    logError('lead_classification_ai.classify', err, { route: 'lib/lead-classification-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
