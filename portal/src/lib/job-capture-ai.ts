import 'server-only';
import { parseJsonObject } from './ai-json';
import { logError } from './observability';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// Fase 2 — captura de trabajo por voz.
//
// El profesional manda una nota de voz al acabar:
//
//   «Acabo de terminar en casa de García, calle Mayor 14, cambio de termo
//    eléctrico, 340 euros, hay que volver en un año a revisarlo.»
//
// y de ahí salen un Job, la petición de reseña y el reloj de la
// recuperación. Es la pieza estratégica del producto: es el mecanismo que
// construye la base de datos SIN QUE NADIE LA CONSTRUYA, y resuelve el
// mayor obstáculo operativo de la recuperación — que el cliente no tenga
// una base usable.
//
// Mismo molde que las otras cinco integraciones de IA del portal (fetch
// directo a la Messages API, sin SDK, nunca lanza, degrada con gracia sin
// clave, parseo aislado en función pura y testeable sin red).
//
// DOS REGLAS PROPIAS DE ESTE EXTRACTOR
//
//   1. EL MODELO NO HACE ARITMÉTICA DE FECHAS. Devuelve "dentro de cuántos
//      meses", nunca una fecha. La fecha la calcula el portal a partir de
//      completedAt, que es un dato que ya tiene y no puede equivocarse.
//      Pedirle a un modelo que sume un año a la fecha de hoy es regalarle
//      una oportunidad de fallar en algo que un `setMonth` hace exacto.
//
//   2. EL MODELO NO INVENTA IMPORTES. Si no se dijo una cifra, devuelve
//      null y el importe se queda vacío. Un presupuesto con un número
//      plausible pero inventado es peor que uno sin número: el segundo se
//      ve, el primero se cobra.
//
// LO QUE ESTO NO HACE: no escribe en la base. Devuelve lo que entendió y
// ya está. Quien llame decide, y el diseño exige que antes lo confirme una
// persona — el profesional ve una tarjeta y pulsa [Confirmar]. Guardar
// directamente lo que entendió un modelo de una nota de voz grabada en una
// furgoneta con el motor encendido sería como mínimo optimista.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TRANSCRIPT_CHARS = 2000;
const MAX_FIELD_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1000;
/** Tope de sensatez para "vuelve dentro de N meses": diez años. Un modelo
 *  que devuelva 1200 se ha equivocado, y un recordatorio para el año 2126
 *  no lo va a corregir nadie porque nadie lo verá nunca. */
const MAX_NEXT_SERVICE_MONTHS = 120;

export async function isJobCaptureConfigured(): Promise<boolean> {
  return (await resolveActiveAnthropicCredentials()) !== null;
}

export interface JobCaptureEquipment {
  brand: string | null;
  model: string | null;
  installedYear: number | null;
}

export interface JobCaptureFields {
  /**
   * Qué creyó entender que es esto.
   *
   * 'unclear' NO es un fallo: es un desenlace legítimo y frecuente. Una
   * nota de voz que dice "recuérdame llamar a Pepe" no es ni un trabajo ni
   * un presupuesto, y forzarla a ser uno de los dos llenaría la base de
   * trabajos fantasma de cero euros.
   */
  kind: 'job' | 'quote' | 'unclear';
  /** El nombre tal y como lo dijo. Casarlo con un Contact es trabajo de
   *  quien llama, y difuso — ver la cabecera de Job en el esquema. */
  contactName: string | null;
  /** Lo que ayude a identificar a esa persona: dirección, referencia. */
  contactHint: string | null;
  serviceType: string | null;
  amount: number | null;
  currency: string | null;
  equipment: JobCaptureEquipment | null;
  /** Meses hasta la próxima revisión. La FECHA la calcula el portal. */
  nextServiceMonths: number | null;
  description: string | null;
}

export type JobCaptureResult =
  | ({ ok: true; skipped?: false } & JobCaptureFields)
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

const SYSTEM = `Eres un extractor de datos para un profesional de servicios a domicilio (fontanería, electricidad, climatización, mantenimiento).

Recibes la TRANSCRIPCIÓN de una nota de voz que el profesional graba al terminar en casa de un cliente, o al enviar un presupuesto. Suelen ser dictadas de pie, con ruido, y con frases sin terminar.

Devuelve SOLO un objeto JSON, sin texto antes ni después y sin vallas de código, con exactamente estas claves:

{
  "kind": "job" | "quote" | "unclear",
  "contactName": string | null,
  "contactHint": string | null,
  "serviceType": string | null,
  "amount": number | null,
  "currency": string | null,
  "equipment": { "brand": string|null, "model": string|null, "installedYear": number|null } | null,
  "nextServiceMonths": number | null,
  "description": string | null
}

Reglas:
- "kind": "job" si el trabajo YA se hizo. "quote" si es un presupuesto enviado o por enviar, es decir, trabajo todavía no hecho. "unclear" si no es ninguna de las dos cosas (un recordatorio, una nota suelta, algo ininteligible).
- NO INVENTES NADA. Si un dato no se dice, va null. Es siempre preferible null a una suposición razonable.
- "amount": solo la cifra, sin símbolo ni separadores de miles. Si no se dice importe, null.
- "nextServiceMonths": CUÁNTOS MESES faltan hasta la próxima revisión, como número entero. "en un año" son 12, "cada seis meses" son 6. NUNCA devuelvas una fecha; no conoces la de hoy.
- "contactHint": la dirección o la referencia que permita reconocer a esa persona, tal cual se dijo.
- "description": una frase con lo que se hizo o se presupuestó, en las palabras del profesional.
- Responde en español.`;

/**
 * Parseo aislado, para poder probar JSON malformado sin tocar la red.
 *
 * Devuelve null cuando la respuesta no es utilizable en absoluto. Un
 * objeto con campos de más, de menos o con el tipo cambiado NO es null:
 * se saneen y se sigue, porque un modelo que devuelve el 80% de lo pedido
 * sigue ahorrándole al profesional el 80% de teclear.
 */
export function parseJobCaptureResponse(text: string): JobCaptureFields | null {
  const obj = parseJsonObject(text);
  if (obj === null) return null;

  const kind = obj.kind === 'job' || obj.kind === 'quote' ? obj.kind : 'unclear';

  const strOrNull = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;

  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // El importe se acepta positivo o cero, nunca negativo: un trabajo de
  // -340 € es un error de transcripción, no un abono.
  const rawAmount = numOrNull(obj.amount);
  const amount = rawAmount !== null && rawAmount >= 0 ? rawAmount : null;

  const rawMonths = numOrNull(obj.nextServiceMonths);
  const nextServiceMonths =
    rawMonths !== null && rawMonths > 0 && rawMonths <= MAX_NEXT_SERVICE_MONTHS
      ? Math.round(rawMonths)
      : null;

  let equipment: JobCaptureEquipment | null = null;
  if (obj.equipment !== null && typeof obj.equipment === 'object' && !Array.isArray(obj.equipment)) {
    const e = obj.equipment as Record<string, unknown>;
    const year = numOrNull(e.installedYear);
    const brand = strOrNull(e.brand, MAX_FIELD_CHARS);
    const model = strOrNull(e.model, MAX_FIELD_CHARS);
    // Un equipo con los tres campos vacíos es ruido, no un equipo.
    const installedYear = year !== null && year >= 1900 && year <= 2200 ? Math.round(year) : null;
    if (brand || model || installedYear !== null) equipment = { brand, model, installedYear };
  }

  return {
    kind,
    contactName: strOrNull(obj.contactName, MAX_FIELD_CHARS),
    contactHint: strOrNull(obj.contactHint, MAX_FIELD_CHARS),
    serviceType: strOrNull(obj.serviceType, MAX_FIELD_CHARS),
    amount,
    currency: strOrNull(obj.currency, 8),
    equipment,
    nextServiceMonths,
    description: strOrNull(obj.description, MAX_DESCRIPTION_CHARS),
  };
}

/**
 * La fecha de la próxima revisión, calculada AQUÍ y no por el modelo.
 *
 * `setMonth` desborda el año solo, y el ajuste de fin de mes es el que se
 * quiere: un trabajo del 31 de enero con revisión "en un mes" cae el 3 de
 * marzo y no el 31 de febrero, que no existe. Para un recordatorio de
 * mantenimiento, dos días de deriva son irrelevantes; una fecha inválida,
 * no.
 */
export function nextServiceDate(completedAt: Date, months: number | null): Date | null {
  if (months === null) return null;
  const due = new Date(completedAt.getTime());
  due.setMonth(due.getMonth() + months);
  return due;
}

export async function extractJobFromTranscript(transcript: string): Promise<JobCaptureResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }
  const { apiKey, baseUrl } = resolved;
  const model = process.env.ANTHROPIC_JOB_CAPTURE_MODEL ?? resolved.model;

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
        system: SYSTEM,
        messages: [{ role: 'user', content: transcript.slice(0, MAX_TRANSCRIPT_CHARS) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((block) => block.type === 'text')?.text?.trim();
    if (!text) return { ok: false, error: 'anthropic_api_empty_response' };

    const parsed = parseJobCaptureResponse(text);
    if (!parsed) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, ...parsed };
  } catch (err) {
    logError('job_capture_ai.extract', err, { route: 'lib/job-capture-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
