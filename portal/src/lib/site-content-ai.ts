import 'server-only';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';
import { logError } from './observability';
import { defaultHomePage, parseSiteContent, resolveContentPath, SITE_LIMITS, type SiteContent } from './site-content';
import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// Webs con IA, entrega 3 (27/10/2026) — del texto del borrador al CONTENIDO
// completo de una web con plantilla de diseño.
//
// El titular, el subtítulo, los servicios y el cierre los sigue escribiendo
// web-draft-ai.ts, que ya se ha probado con negocios reales y saca el titular
// de lo que repiten sus reseñas. Esto AMPLÍA ese texto con lo que una web
// completa tendría —cifras, pasos, precios, garantías, zona, preguntas— para
// que el dueño vea las posibilidades de su web. Es la idea de Orlando del
// 26/10: datos de ejemplo, siempre MARCADOS, que él cambia o quita antes de
// publicar (publishWebsite se niega mientras quede alguno).
//
// Dos redes de seguridad, porque esto acaba en la cara del dueño del negocio:
// - Todo texto con una cifra que el modelo no haya marcado se marca aquí. En
//   la prueba del 26/10 marcó bien los números, pero un precio inventado sin
//   marca sería publicidad engañosa con su nombre.
// - Nunca reseñas, valoraciones ni nombres: no hay campo donde ponerlos. Lo
//   de Google sale de Google y en vivo.
//
// 27/10/2026: si la plantilla admite el color y la letra de cada negocio
// (site-style.ts), el modelo elige también entre los que ofrece, por el
// oficio o por el nombre («Fontanería Azul»). Solo entre esos: un color
// inventado no está medido. Así dos fontaneros del mismo pueblo con la misma
// plantilla no salen iguales. Si no elige, o elige algo que no está, se queda
// lo de la plantilla.
//
// Haiku por defecto: es ampliar un texto ya hecho con un esquema fijo, y
// cuesta menos de un céntimo. ANTHROPIC_SITE_CONTENT_MODEL lo cambia en local.
// Mismo molde que las demás integraciones: nunca lanza, parseo puro.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_SITE_CONTENT_MODEL = 'claude-haiku-5-5';

export interface DraftExpansionInput {
  businessName: string;
  /** El oficio en palabras («Fontanería»). */
  kind: string | null;
  city: string | null;
  copy: WebDraftCopy;
  /** Los iconos que tiene la plantilla elegida (sin «i-»). */
  iconIds: string[];
  /** Los colores y las letras que admite la plantilla (la primera opción de
   *  cada lista es la suya). Null si no admite cambios. */
  estilo?: DraftStyleOptions | null;
}

export interface DraftStyleOptions {
  muestras: { nombre: string; color: string }[];
  parejas: { id: string; nombre: string }[];
}

export type ExpandDraftResult =
  | { ok: true; content: SiteContent; model: string }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string };

function buildSystem(): string {
  return `Completas el contenido de la web de un pequeño negocio local español a partir del texto que ya tiene. Es un BORRADOR para que el dueño vea las posibilidades de su web: puedes proponer datos de ejemplo verosímiles (precios orientativos, plazos, garantías, años, zona, preguntas frecuentes), pero CADA dato inventado que sea una afirmación sobre el negocio va en "ejemplos" para que salga marcado y él lo cambie.

Devuelves SOLO un JSON, sin vallas de markdown:
{
  "iconos_servicios": [string],   // uno por servicio, en el mismo orden, elegido de la lista de iconos
  "cifras": [{"valor": string, "etiqueta": string}],          // 2 o 3; valor corto («Mismo día», «15 años»)
  "proceso": [{"titulo": string, "texto": string}],           // 3 o 4 pasos de cómo trabaja
  "precios": {"nota": string, "filas": [{"concepto": string, "precio": string, "detalle": string}]},  // 3 a 5 filas, precios «Desde X €»
  "garantias": [{"titulo": string, "texto": string}],         // 2 o 3
  "zona": {"texto": string, "lugares": [{"nombre": string}]}, // 3 a 6 lugares cercanos a su ciudad
  "faq": [{"pregunta": string, "respuesta": string}],         // 3 a 5
  "ejemplos": [string],  // rutas de lo inventado: "cifras.0.valor", "precios.filas.1.precio", "garantias.0.texto", "zona.lugares.2.nombre", "faq.1.respuesta"…
  "color": string,       // solo si se te dan colores: el nombre de uno, el que mejor le vaya por su oficio o su nombre
  "letra": string        // solo si se te dan letras: el nombre de una
}

Reglas:
- Toda cifra, precio, año, plazo, garantía, lugar o afirmación concreta que te inventes va en "ejemplos". Ante la duda, márcalo.
- Nunca inventes opiniones, valoraciones, número de reseñas ni nombres de personas.
- Coherente con su texto y su oficio; nada de frases de agencia. Español de España; al visitante se le habla de usted.
- Textos cortos: títulos de 2 a 5 palabras, textos de una o dos frases, respuestas de dos o tres frases.`;
}

function buildUser(input: DraftExpansionInput): string {
  return [
    `Negocio: ${input.businessName}`,
    input.kind ? `Oficio: ${input.kind}` : null,
    input.city ? `Ciudad: ${input.city}` : null,
    `Titular: ${input.copy.headline}`,
    input.copy.subheadline ? `Subtítulo: ${input.copy.subheadline}` : null,
    input.copy.about ? `Sobre el negocio: ${input.copy.about}` : null,
    `Servicios:\n${input.copy.services.map((s, i) => `${i + 1}. ${s.name}: ${s.description}`).join('\n')}`,
    `Iconos disponibles: ${input.iconIds.join(', ') || 'check'}`,
    input.estilo?.muestras.length ? `Colores disponibles: ${input.estilo.muestras.map((m) => m.nombre).join(', ')}` : null,
    input.estilo?.parejas.length ? `Letras disponibles: ${input.estilo.parejas.map((p) => p.nombre).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []);

/**
 * Función pura: el contenido v2 a partir del texto del borrador y de lo que
 * propuso el modelo (o de nada, si falló: entonces sale solo con lo que ya
 * había). Recorta a los topes del esquema, descarta lo vacío, ajusta las
 * rutas de ejemplo y marca cualquier cifra que se haya quedado sin marcar.
 */
export function buildSiteContentFromDraft(copy: WebDraftCopy, expansion: unknown, iconIds: string[], estilo: DraftStyleOptions | null = null): SiteContent {
  const e = (expansion && typeof expansion === 'object' ? expansion : {}) as Record<string, unknown>;
  const icons = Array.isArray(e.iconos_servicios) ? e.iconos_servicios : [];
  const iconOk = new Set(iconIds);
  const datos: SiteContent['datos'] = {
    titular: str(copy.headline, 90) || 'Su web',
    subtitulo: str(copy.subheadline, 220),
    sobre: str(copy.about, 1200),
    llamada_accion: str(copy.callToAction, 90),
    servicios: copy.services.slice(0, SITE_LIMITS.servicios).map((s, i) => ({
      nombre: str(s.name, 80) || 'Servicio',
      descripcion: str(s.description, 300),
      icono: typeof icons[i] === 'string' && iconOk.has(icons[i] as string) ? (icons[i] as string) : '',
    })),
    cifras: arr(e.cifras)
      .map((c) => ({ valor: str(c.valor, 30), etiqueta: str(c.etiqueta, 90) }))
      .filter((c) => c.valor)
      .slice(0, SITE_LIMITS.cifras),
    proceso: arr(e.proceso)
      .map((p) => ({ titulo: str(p.titulo, 80), texto: str(p.texto, 300) }))
      .filter((p) => p.titulo)
      .slice(0, SITE_LIMITS.proceso),
    precios: {
      nota: str((e.precios as Record<string, unknown> | undefined)?.nota, 200),
      filas: arr((e.precios as Record<string, unknown> | undefined)?.filas)
        .map((f) => ({ concepto: str(f.concepto, 120), precio: str(f.precio, 40), detalle: str(f.detalle, 200) }))
        .filter((f) => f.concepto && f.precio)
        .slice(0, SITE_LIMITS.preciosFilas),
    },
    garantias: arr(e.garantias)
      .map((g) => ({ titulo: str(g.titulo, 80), texto: str(g.texto, 300) }))
      .filter((g) => g.titulo)
      .slice(0, SITE_LIMITS.garantias),
    zona: {
      texto: str((e.zona as Record<string, unknown> | undefined)?.texto, 400),
      lugares: arr((e.zona as Record<string, unknown> | undefined)?.lugares)
        .map((l) => ({ nombre: str(l.nombre, 60) }))
        .filter((l) => l.nombre)
        .slice(0, SITE_LIMITS.lugares),
    },
    faq: arr(e.faq)
      .map((f) => ({ pregunta: str(f.pregunta, 160), respuesta: str(f.respuesta, 1200) }))
      .filter((f) => f.pregunta)
      .slice(0, SITE_LIMITS.faq),
    horario: [],
  };
  if (!datos.servicios.length) datos.servicios = [{ nombre: 'Servicios', descripcion: '', icono: '' }];

  const content: SiteContent = {
    version: 2,
    paginas: [defaultHomePage()],
    datos,
    bloques: [],
    ejemplos: [],
    legal: { titular: '', nif: '', domicilio: '', email: '', registro: '' },
    seccionesConfirmadas: [],
    blog: { titulo: 'Blog', intro: '', entradas: [] },
    urlPublica: '',
    verificacionGoogle: '',
  };
  // El color y la letra, por nombre y solo de los ofrecidos. La primera
  // opción es la de la plantilla: se guarda vacía, como si no se eligiera.
  const byName = <T extends { nombre: string }>(list: T[], value: unknown): T | undefined =>
    typeof value === 'string' ? list.find((x) => x.nombre.toLowerCase() === value.trim().toLowerCase()) : undefined;
  const color = estilo ? byName(estilo.muestras, e.color) : undefined;
  const letra = estilo ? byName(estilo.parejas, e.letra) : undefined;
  if (color || letra) {
    content.estilo = {
      acento: color && color !== estilo?.muestras[0] ? color.color.toLowerCase() : '',
      tipografia: letra && letra !== estilo?.parejas[0] ? letra.id : '',
    };
  }
  // Las rutas que propuso el modelo, solo si existen (al recortar o descartar
  // elementos, una ruta puede haberse quedado apuntando a nada).
  const proposed = Array.isArray(e.ejemplos) ? e.ejemplos.filter((r): r is string => typeof r === 'string') : [];
  const marked = new Set(proposed.filter((r) => resolveContentPath(content, r) !== undefined));
  // Y la red: toda cifra sin marcar, se marca. Lo que escribió el borrador
  // original (titular, servicios) no se toca: no lleva datos inventados.
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (/\d/.test(value)) marked.add(path);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}.${i}`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  };
  for (const key of ['cifras', 'proceso', 'precios', 'garantias', 'zona', 'faq'] as const) walk(datos[key], key);
  content.ejemplos = Array.from(marked).slice(0, 200);

  const parsed = parseSiteContent(content);
  return parsed.ok ? parsed.content : { ...content, ejemplos: [] };
}

/** Interpreta la respuesta del modelo; null si no es JSON. */
export function parseExpansionResponse(text: string): unknown | null {
  try {
    const value = JSON.parse(stripCodeFence(text)) as unknown;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export async function expandDraftToSiteContent(input: DraftExpansionInput): Promise<ExpandDraftResult> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: true, skipped: true, reason: 'no_api_key' };
  // `||`: una variable declarada y vacía cuenta como ausente (trampa nº 4).
  const model = process.env.ANTHROPIC_SITE_CONTENT_MODEL || DEFAULT_SITE_CONTENT_MODEL;
  try {
    const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolved.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: 4000, system: buildSystem(), messages: [{ role: 'user', content: buildUser(input) }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
    const expansion = parseExpansionResponse(text);
    if (!expansion) return { ok: false, error: 'anthropic_api_invalid_json' };
    return { ok: true, content: buildSiteContentFromDraft(input.copy, expansion, input.iconIds, input.estilo ?? null), model };
  } catch (err) {
    logError('site_content_ai.expand', err, { route: 'lib/site-content-ai.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
