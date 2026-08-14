import 'server-only';
import { logError } from './observability';

// =============================================================================
// WP-22c — AI-drafted replies to Google reviews. First AI-provider
// integration in this portal codebase (confirmed by grep before
// building this — the real chatbot's own generation lives in a
// different system entirely). Uses Anthropic's Messages API directly
// via fetch, matching this codebase's existing convention for
// Google's REST endpoints (google-business.ts) rather than adding a new
// SDK dependency for one endpoint.
//
// Every draft is just that — a draft. Nothing in this file publishes
// anything; publishReviewReply (google-business.ts) is a separate,
// deliberate step the caller only reaches after either a human approval
// or an explicit autoPublishReplies=true setting (WP-22c AC).
// =============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_DRAFT_CHARS = 600;

export function isReviewReplyAIConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function toneGuidance(starRating: number): string {
  if (starRating >= 4) return 'La reseña es positiva. Agradece con calidez y, si la reseña menciona algo concreto, reconócelo brevemente.';
  if (starRating === 3) return 'La reseña es mixta. Agradece el feedback y muestra disposición a mejorar, sin sonar a disculpa exagerada.';
  return 'La reseña es negativa. Responde con empatía genuina, sin admitir culpa sobre hechos que no conoces ni prometer compensaciones, e invita a contactar por otro canal para resolverlo.';
}

export interface GenerateReplyDraftInput {
  businessName: string;
  reviewerName: string | null;
  starRating: number;
  comment: string | null;
}

export type GenerateReplyDraftResult =
  | { ok: true; draft: string }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

export async function generateReviewReplyDraft(input: GenerateReplyDraftInput): Promise<GenerateReplyDraftResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }

  const model = process.env.ANTHROPIC_REVIEW_REPLY_MODEL ?? DEFAULT_MODEL;
  const system = [
    `Escribes, en nombre de "${input.businessName}", una respuesta pública a una reseña de Google.`,
    'Reglas estrictas:',
    '- Responde SOLO con el texto de la respuesta, sin comillas, sin preámbulo, sin explicaciones.',
    '- 2 a 4 frases como máximo, en español, tono profesional y cercano.',
    '- Nunca inventes hechos sobre lo ocurrido que no estén en la reseña.',
    '- Nunca ofrezcas descuentos, reembolsos ni compensaciones concretas.',
    '- Nunca menciones políticas internas del negocio.',
    toneGuidance(input.starRating),
  ].join('\n');

  const userContent = [
    `Valoración: ${input.starRating}/5 estrellas.`,
    `Nombre del cliente: ${input.reviewerName ?? 'no indicado'}.`,
    `Texto de la reseña: ${input.comment ? `"${input.comment}"` : '(sin comentario, solo valoración numérica)'}`,
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
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userContent }],
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
    return { ok: true, draft: text.slice(0, MAX_DRAFT_CHARS) };
  } catch (err) {
    logError('review_reply_ai.generate_draft', err, { route: 'lib/review-reply-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
