import 'server-only';

// =============================================================================
// Utilidades compartidas para las respuestas JSON de los modelos.
//
// Extraído de lead-classification-ai.ts cuando chatbot-reply-ai.ts necesitó
// exactamente lo mismo: mejor una función con su motivo escrito una vez que
// dos copias que se arreglan por separado la próxima vez que un modelo
// cambie de costumbres.
// =============================================================================

/**
 * Quita la valla de código markdown que envuelve la respuesta.
 *
 * Encontrado en real contra la API de Anthropic (2026-09-06): pese a que el
 * prompt de sistema dice explícitamente "SOLO un objeto JSON, sin texto antes
 * ni después", Haiku envuelve el objeto en ```json con la frecuencia
 * suficiente como para que fallara el 100% de un barrido real de
 * clasificación de leads. La clasificación en sí era correcta siempre; lo
 * único que rompía era la valla.
 *
 * Devuelve el texto tal cual cuando no hay valla, así que es seguro llamarla
 * siempre antes de `JSON.parse`.
 */
export function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

/**
 * `JSON.parse` tolerante a la valla, que además garantiza que lo devuelto es
 * un objeto plano — ni null, ni array, ni un número suelto. Devuelve null en
 * vez de lanzar: el que llama decide si eso es un error o un caso degradado.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}
