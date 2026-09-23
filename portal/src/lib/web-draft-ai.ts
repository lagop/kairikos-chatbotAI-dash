import 'server-only';
import { parseJsonObject } from './ai-json';
import { logError } from './observability';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';

// =============================================================================
// A11, capa 1 — los textos del borrador de web de un prospecto.
//
// Para qué: en la llamada comercial, el informe comparativo dice "tu web es
// una ficha de un directorio"; el borrador enseña CÓMO QUEDARÍA LA SUYA, con
// su nombre, sus servicios y sus reseñas reales. Lo primero abre la
// conversación, lo segundo la cierra.
//
// Mismo molde que prospecting-brief-ai.ts: fetch directo a la Messages API,
// sin SDK, NUNCA LANZA, degrada con gracia sin clave, y el parseo aislado en
// una función pura para poder probar JSON malformado sin tocar la red. No ve
// la base de datos ni un clientId: recibe texto y devuelve texto.
//
// SONNET, NO HAIKU, y es la primera integración del repo que lo pide. El resto
// exprime texto (clasificar un lead, resumir una conversación, extraer datos)
// y Haiku sobra para eso. Esto ESCRIBE el texto que va a leer un negocio real
// para decidir si nos compra, y ahí la diferencia se nota. La cuenta que lo
// justifica: Sonnet 5 cuesta 2$/10$ por millón frente a 1$/5$ de Haiku, o sea
// ~1,8 céntimos por borrador en vez de ~0,9. Duplicar un céntimo, a cien
// borradores al mes, son dos euros. No es una decisión de coste.
//
// El modelo va como constante local y no en la pantalla de ajustes a
// propósito: ese ajuste es global y cambiarlo ahí movería TAMBIÉN el modelo
// del chatbot y de los clasificadores, que no quieren Sonnet.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';

/** Sonnet 5, salvo que una variable lo pise (sirve en local; en la VPS los
 *  ANTHROPIC_*_MODEL no llegan al contenedor — ver CLAUDE.md). */
const DEFAULT_MODEL = 'claude-sonnet-5';

const MAX_HEADLINE_CHARS = 90;
const MAX_PARAGRAPH_CHARS = 400;
const MAX_SERVICES = 6;
const MAX_SERVICE_NAME_CHARS = 60;
const MAX_SERVICE_TEXT_CHARS = 180;

export interface WebDraftInput {
  businessName: string;
  /** Categoría de Google ('hair_salon'): de aquí salen los servicios
   *  plausibles cuando no hay más material. */
  primaryType: string | null;
  /** El rubro que escribió el cliente en su campaña, en español. */
  category: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export interface WebDraftService {
  name: string;
  description: string;
}

export interface WebDraftCopy {
  /** Titular de portada. Lo primero que lee el prospecto de sí mismo. */
  headline: string;
  subheadline: string;
  about: string;
  services: WebDraftService[];
  /** Frase de cierre sobre pedir cita o presupuesto. */
  callToAction: string;
}

export type WebDraftResult =
  | { ok: true; copy: WebDraftCopy; model: string }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

function clean(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

/**
 * Función pura: convierte la respuesta del modelo en textos utilizables, o
 * null si no hay nada aprovechable. Aislada para poder probar el JSON
 * malformado, la valla de markdown y los campos que faltan sin red.
 *
 * Criterio de "aprovechable": sin titular no hay portada, y una portada sin
 * titular es peor que no enseñar nada. El resto puede faltar y la plantilla
 * se las arregla.
 */
export function parseWebDraftResponse(text: string): WebDraftCopy | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;

  const headline = clean(raw.headline, MAX_HEADLINE_CHARS);
  if (!headline) return null;

  const services = Array.isArray(raw.services)
    ? raw.services
        .map((item) => {
          const entry = item as Record<string, unknown> | null;
          return {
            name: clean(entry?.name, MAX_SERVICE_NAME_CHARS),
            description: clean(entry?.description, MAX_SERVICE_TEXT_CHARS),
          };
        })
        .filter((s) => s.name.length > 0)
        .slice(0, MAX_SERVICES)
    : [];

  return {
    headline,
    subheadline: clean(raw.subheadline, MAX_PARAGRAPH_CHARS),
    about: clean(raw.about, MAX_PARAGRAPH_CHARS),
    services,
    callToAction: clean(raw.callToAction, MAX_HEADLINE_CHARS),
  };
}

function buildSystem(): string {
  return [
    'Escribes los textos de la web de un negocio local español. El negocio todavía no es cliente: esto es una propuesta que verá su dueño.',
    'Respondes SOLO con un objeto JSON, sin texto alrededor y sin vallas de markdown.',
    'Formato: {"headline": string, "subheadline": string, "about": string, "services": [{"name": string, "description": string}], "callToAction": string}.',
    '',
    'headline: menos de 90 caracteres. Lo que hace y para quién, con su ciudad si se sabe. Nada de "Bienvenidos a".',
    'subheadline: una frase de apoyo, menos de 200 caracteres.',
    'about: dos o tres frases sobre el negocio. Solo con lo que se te da.',
    'services: entre 3 y 6 servicios PLAUSIBLES para ese tipo de negocio, cada uno con una descripción de una frase.',
    'callToAction: frase corta para pedir cita o presupuesto por teléfono.',
    '',
    // Esta es la regla que importa. El borrador se enseña al propio dueño del
    // negocio, que sabe perfectamente qué hace y qué no: un dato inventado
    // (años de experiencia, premios, número de empleados) lo detecta en el
    // acto y tira por tierra la propuesta entera, igual que pasó con el
    // informe comparativo y los 300 € por corte de pelo.
    'REGLA CRÍTICA: no inventes datos. Nada de años de experiencia, fundadores, premios, número de empleados, precios ni horarios si no se te dan.',
    'Los servicios son los típicos del sector, descritos en general: es una propuesta, no una descripción de su negocio real.',
    'Escribe en español de España, en tercera persona o impersonal, sin superlativos vacíos ("los mejores", "líderes del sector").',
  ].join('\n');
}

function buildUserContent(input: WebDraftInput): string {
  const parts = [`Negocio: ${input.businessName}`];
  if (input.category) parts.push(`Tipo de negocio: ${input.category}`);
  if (input.primaryType) parts.push(`Categoría de Google: ${input.primaryType}`);
  if (input.city) parts.push(`Ciudad: ${input.city}`);
  if (input.address) parts.push(`Dirección: ${input.address}`);
  if (input.phone) parts.push(`Teléfono: ${input.phone}`);
  if (input.rating !== null && input.reviewCount !== null) {
    parts.push(`Valoración en Google: ${input.rating} sobre 5 con ${input.reviewCount} reseñas`);
  }
  return parts.join('\n');
}

export async function generateWebDraftCopy(input: WebDraftInput): Promise<WebDraftResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: true, skipped: true, reason: 'no_api_key' };

  // Ojo con el orden: aquí el modelo NO cae a resolved.model como en las demás
  // integraciones. Ese es el modelo global de la pantalla de ajustes (hoy
  // Haiku) y usarlo devolvería justo la calidad de texto que esta integración
  // existe para evitar.
  const model = process.env.ANTHROPIC_WEB_DRAFT_MODEL ?? DEFAULT_MODEL;
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
        max_tokens: 1500,
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
    const copy = parseWebDraftResponse(text);
    if (!copy) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, copy, model };
  } catch (err) {
    logError('web_draft_ai.generate', err, { route: 'lib/web-draft-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
