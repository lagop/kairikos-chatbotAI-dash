import { z } from 'zod';
import { SITE_SECTION_TYPES, type SiteContent, type SiteSectionRef } from './site-content';
import { SITE_SECTION_VARIANTS } from './site-section-variants';

// =============================================================================
// 02/11/2026 — la estructura propia de una plantilla: qué secciones lleva su
// portada, en qué orden y con qué disposición.
//
// Nació con Oficios · Circuito, que viene de una landing (la de electricidad
// que Orlando pasó el 02/11). Sin esto, todo borrador salía con el orden de
// siempre (defaultHomePage: portada, cifras, servicios, sobre…) y con las
// disposiciones alternadas (conDisposicionesAlternadas, 31/10), así que una
// landing convertida nunca llegaba al prospecto como era. Orlando: que salga
// tal cual la estructura de la landing; luego, con el editor, se cambia.
//
// Con estructura, el borrador nuevo sale con ella y SIN alternar: la plantilla
// ya decidió cómo se ve. Sin estructura, todo sigue como antes.
//
// Lo que la estructura no nombra no se pinta, pero el CONTENIDO se queda: las
// garantías o los precios que escribió la IA siguen en `datos`, y el dueño los
// recupera añadiendo la sección desde el editor. Los bloques sí se quitan
// (bloque, sitio y marcas de ejemplo): uno sin sitio en ninguna página dejaría
// marcas pendientes que nadie ve y la publicación se negaría por ellas.
//
// No lo valida site-template-validate.ts (que mira el HTML), sino
// scripts/plantilla-a-mano.ts al subirla: es una declaración, como el estilo.
// =============================================================================

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const itemSchema = z.union([
  z.object({ tipo: z.enum(SITE_SECTION_TYPES), variante: z.string().regex(SLUG_RE).max(30).optional() }).strict(),
  z.object({ tipo: z.literal('bloque'), id: z.string().regex(SLUG_RE).max(40) }).strict(),
]);

const structureSchema = z.object({ portada: z.array(itemSchema).min(1).max(30) }).strict();

export type SiteTemplateStructure = z.infer<typeof structureSchema>;

/** Lo que tiene que corregirse en la estructura de plantilla.json; vacío si vale. */
export function templateStructureProblems(value: unknown): string[] {
  const parsed = structureSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((i) => `estructura.${i.path.join('.')}: ${i.message}`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.portada) {
    const key = item.tipo === 'bloque' ? `bloque:${item.id}` : item.tipo;
    if (seen.has(key)) problems.push(`estructura.portada: «${key}» sale dos veces.`);
    seen.add(key);
    if (item.tipo !== 'bloque' && item.variante && !(SITE_SECTION_VARIANTS[item.tipo] ?? []).some((v) => v.id === item.variante)) {
      problems.push(`estructura.portada: la sección «${item.tipo}» no tiene la disposición «${item.variante}».`);
    }
  }
  if (parsed.data.portada[0]?.tipo !== 'portada') problems.push('estructura.portada: tiene que empezar por la portada.');
  return problems;
}

/** La estructura guardada en la fila, o null si no tiene (o no vale: entonces
 *  el borrador sale como cualquier otro, que es mejor que no salir). */
export function parseTemplateStructure(value: unknown): SiteTemplateStructure | null {
  if (value == null || templateStructureProblems(value).length) return null;
  return structureSchema.parse(value);
}

/** La portada del contenido con la estructura de la plantilla. Función pura. */
export function conEstructura(content: SiteContent, estructura: SiteTemplateStructure): SiteContent {
  const next = structuredClone(content);
  const at = Math.max(0, next.paginas.findIndex((p) => p.ruta === ''));
  const ids = new Set(next.bloques.map((b) => b.id));
  next.paginas[at].secciones = estructura.portada
    .filter((r) => r.tipo !== 'bloque' || ids.has(r.id))
    .map((r) => ({ ...r }) as SiteSectionRef);
  const usados = new Set(next.paginas.flatMap((p) => p.secciones.flatMap((s) => (s.tipo === 'bloque' ? [s.id] : []))));
  next.bloques = next.bloques.filter((b) => usados.has(b.id));
  next.ejemplos = next.ejemplos.filter((r) => !r.startsWith('bloques.') || usados.has(r.split('.')[1]));
  return next;
}
