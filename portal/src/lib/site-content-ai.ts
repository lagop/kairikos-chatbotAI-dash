import 'server-only';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';
import { logError } from './observability';
import { defaultHomePage, parseSiteContent, resolveContentPath, SITE_LIMITS, type SiteBlock, type SiteContent } from './site-content';
import { COMPARISON_BLOCK_ID, DETAIL_BLOCK_ID, vacio } from './site-sector-blocks';
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
  "faq": [{"pregunta": string, "respuesta": string}],         // 4 a 6, las dudas reales de quien contrata este oficio
  "servicios_detalle": [{"descripcion": string, "incluye": [string]}],  // uno por servicio, en el mismo orden
  "comparativa": {"titulo": string, "texto": string, "columnas": [string], "filas": [{"concepto": string, "valores": [string]}]},  // o null
  "ejemplos": [string],  // rutas de lo inventado: "cifras.0.valor", "precios.filas.1.precio", "garantias.0.texto", "zona.lugares.2.nombre", "faq.1.respuesta"…
  "color": string,       // solo si se te dan colores: el nombre de uno, el que mejor le vaya por su oficio o su nombre
  "letra": string        // solo si se te dan letras: el nombre de una
}

Reglas:
- Toda cifra, precio, año, plazo, garantía, lugar o afirmación concreta que te inventes va en "ejemplos". Ante la duda, márcalo.
- Nunca inventes opiniones, valoraciones, número de reseñas ni nombres de personas.
- Coherente con su texto y su oficio; nada de frases de agencia. Español de España; al visitante se le habla de usted.
- Títulos de 2 a 5 palabras. Textos de una o dos frases; respuestas de la faq de dos a cuatro frases, que resuelvan la duda de verdad.
- servicios_detalle: amplía cada servicio SIN cambiarle el sentido. "descripcion", de dos o tres frases (máximo 280 caracteres): qué es y para quién; "incluye", de 3 a 5 puntos cortos (máximo 12 palabras cada uno) con lo que comprende el trabajo. Explica el oficio: materiales, opciones, cómo se hace. Lo que sea una promesa concreta del negocio (plazos, marcas, garantías) es inventado y va en "ejemplos".
- comparativa: solo si en este oficio el cliente suele dudar entre 2 o 3 opciones (aluminio o PVC, termo eléctrico o de gas, corredera o abatible…). Columnas: las opciones. De 4 a 7 filas; cada valor es «sí», «no» o algo de 1 a 4 palabras. Información general del oficio, honesta: ninguna opción gana en todo. Si no hay una duda así, null.`;
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
const strList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean) : []);

/** La comparativa del oficio, o null si no hay una que se sostenga: de 2 a 4
 *  opciones y al menos 3 filas con un valor por opción. */
function buildComparison(value: unknown): SiteBlock | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const columnas = strList(c.columnas, 40).slice(0, 4);
  if (columnas.length < 2) return null;
  const filas = arr(c.filas)
    .map((f) => ({ concepto: str(f.concepto, 120), valores: strList(f.valores, 60) }))
    .filter((f) => f.concepto && f.valores.length === columnas.length)
    .slice(0, SITE_LIMITS.bloqueFilas);
  if (filas.length < 3) return null;
  return {
    ...vacio(COMPARISON_BLOCK_ID, 'comparativa', str(c.titulo, 90) || columnas.join(' o ')),
    texto: str(c.texto, 400),
    comparativa: { columnas, destacada: -1, filas },
  };
}

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

  // 28/10/2026 — la portada más trabajada (Orlando: «el borrador es solo la
  // portada, pero más currado»). El servicio con su descripción ampliada y,
  // en pestañas, lo que incluye cada uno; y la comparativa del oficio.
  const detalle = arr(e.servicios_detalle);
  const ampliados: number[] = [];
  datos.servicios.forEach((s, i) => {
    const d = str(detalle[i]?.descripcion, 300);
    if (d && copy.services[i]) {
      s.descripcion = d;
      ampliados.push(i);
    }
  });
  const bloques: SiteBlock[] = [];
  const pestanas = datos.servicios
    .map((s, i) => {
      const incluye = strList(detalle[i]?.incluye, 120).slice(0, 6);
      return incluye.length ? { titulo: s.nombre.slice(0, 40).trim(), texto: incluye.map((x) => `- ${x}`).join('\n'), foto: '', alt: '' } : null;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .slice(0, SITE_LIMITS.bloquePestanas);
  if (pestanas.length >= 2) bloques.push({ ...vacio(DETAIL_BLOCK_ID, 'pestanas', 'Qué incluye cada servicio'), pestanas });
  const comparativa = buildComparison(e.comparativa);
  if (comparativa) bloques.push(comparativa);

  const home = defaultHomePage();
  for (const [after, id] of [['servicios', DETAIL_BLOCK_ID], ['proceso', COMPARISON_BLOCK_ID]] as const) {
    if (!bloques.some((b) => b.id === id)) continue;
    const at = home.secciones.findIndex((s) => s.tipo === after);
    home.secciones.splice(at + 1, 0, { tipo: 'bloque', id });
  }

  const content: SiteContent = {
    version: 2,
    paginas: [home],
    datos,
    bloques,
    ejemplos: [],
    legal: { titular: '', nif: '', domicilio: '', email: '', registro: '' },
    seccionesConfirmadas: [],
    blog: { titulo: 'Blog', intro: '', entradas: [] },
    urlPublica: '',
    verificacionGoogle: '',
    imagenes: { logo: '', portada: '' },
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
  for (const i of ampliados) walk(datos.servicios[i].descripcion, `servicios.${i}.descripcion`);
  // Lo que incluye cada servicio es una promesa del negocio, y la comparativa,
  // información que alguien tiene que haber leído: los dos, enteros, de
  // ejemplo (se resaltan y no se publican sin mirarlos, como los de sector).
  for (const b of bloques) marked.add(`bloques.${b.id}.titulo`);
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
      // 28/10/2026 — sin razonamiento: Haiku 5.5 razona por su cuenta si no se
      // le dice, y medido en producción gastaba 5.200–5.700 tokens pensando;
      // con el contenido ampliado, 2 de cada 5 respuestas se cortaban en el
      // tope (stop_reason max_tokens) y el JSON no se leía. Rellenar un
      // esquema no lo necesita: sin él, 11–12 s y ~2.600 tokens, y todas bien.
      // Solo en Haiku: Sonnet 5.5 rechaza `disabled` (400, pide otro valor).
      // Los demás modelos (solo en local, por la variable) razonan con más
      // margen de tope.
      body: JSON.stringify({
        model,
        max_tokens: model.includes('haiku') ? 8000 : 16000,
        ...(model.includes('haiku') ? { thinking: { type: 'disabled' } } : {}),
        system: buildSystem(),
        messages: [{ role: 'user', content: buildUser(input) }],
      }),
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
