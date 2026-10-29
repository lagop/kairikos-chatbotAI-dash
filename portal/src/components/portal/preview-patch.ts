// =============================================================================
// El texto escrito en el formulario, en la vista AL MOMENTO (29/10/2026).
//
// La vista previa se pide al servidor medio segundo después de dejar de
// escribir (SiteLivePreview): con buena conexión no se nota, con un móvil y
// mala cobertura sí. Mientras llega, el editor cambia en la vista los textos
// que puede cambiar sin el servidor: los <k-dato> de una línea, que contienen
// exactamente el valor de su campo (el motor lo pinta tal cual, escapado; ver
// applyEditMarks en site-template.ts). Luego llega la página del servidor y se
// pinta encima, como siempre: si algo no cuadrara, dura medio segundo.
//
// Dos reglas para no enseñar nunca algo que el servidor no pintaría:
// - Solo si cambió UN dato. Subir un servicio cambia muchos a la vez, y mover
//   solo los textos (sin sus iconos ni fotos) se vería raro: eso espera.
// - Solo donde la vista enseña justo el valor anterior. Si muestra otra cosa
//   (un ejemplo marcado, un texto formateado), no se toca.
//
// Puro y sin DOM, aquí al lado del componente (los componentes de cliente no
// importan libs): se prueba en Node.
// =============================================================================

type Content = { datos?: unknown; bloques?: { id: string }[] };

/** El valor de un dato por su ruta, igual que setValue en SiteContentEditor:
 *  'titular', 'servicios.2.nombre', 'bloques.<id>.titulo'. */
export function valueAt(content: Content, ruta: string): unknown {
  const parts = ruta.split('.');
  let cur: unknown;
  let rest: string[];
  if (parts[0] === 'bloques') {
    cur = content.bloques?.find((b) => b.id === parts[1]);
    rest = parts.slice(2);
  } else {
    cur = content.datos;
    rest = parts;
  }
  for (const p of rest) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const asText = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);

/**
 * Qué textos de la vista cambiar ya. `shown` son los <k-dato> de una línea que
 * hay en la vista: su ruta y el texto que enseñan. Devuelve, para cada uno que
 * toca cambiar, su posición en `shown` y el texto nuevo.
 */
export function instantTextPatches(prev: Content, next: Content, shown: { ruta: string; text: string }[]): { index: number; text: string }[] {
  const changed = new Map<string, { before: string; after: string }>();
  for (const { ruta } of shown) {
    if (changed.has(ruta)) continue;
    const before = asText(valueAt(prev, ruta));
    const after = asText(valueAt(next, ruta));
    if (before !== after) changed.set(ruta, { before: before ?? '', after: after ?? '' });
  }
  if (changed.size !== 1) return [];
  const [[ruta, { before, after }]] = [...changed];
  // Vacío no: el servidor puede quitar el elemento entero, y un hueco vacío en
  // la vista engaña más que medio segundo de espera.
  if (!after.trim()) return [];
  return shown.flatMap((s, index) => (s.ruta === ruta && s.text === before ? [{ index, text: after }] : []));
}
