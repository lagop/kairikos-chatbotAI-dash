// =============================================================================
// Deshacer y rehacer en el editor de la web (29/10/2026).
//
// Hasta hoy, quitar un servicio sin querer con el ✕ de la vista, o borrar un
// párrafo, solo tenía un arreglo: volver a escribirlo, o salir sin guardar y
// perder todo lo demás. Ahora el editor guarda una foto del contenido antes de
// cada cambio y la recupera con ↶ / Ctrl+Z.
//
// Escribir no llena el historial letra a letra: los cambios seguidos sobre el
// MISMO campo, sin una pausa de más de COALESCE_MS, son un solo paso. Lo demás
// (subir, quitar, confirmar, cambiar una foto…) es siempre un paso propio.
//
// Las fotos son el contenido entero, no diferencias: SiteContentEditor nunca
// muta un contenido ya pintado (cada cambio es un structuredClone), así que
// guardar la referencia basta y no cuesta memoria más allá de lo que cambió.
//
// Puro y sin React, aquí al lado del componente y no en lib/ (los componentes
// de cliente no importan libs): se prueba en Node, sin DOM.
// =============================================================================

export const HISTORY_MAX = 100;
export const COALESCE_MS = 1500;

export interface EditHistory<T> {
  past: T[];
  future: T[];
  /** El campo del último cambio, para juntar lo que se escribe seguido. */
  key: unknown;
  at: number;
}

export function emptyHistory<T>(): EditHistory<T> {
  return { past: [], future: [], key: null, at: 0 };
}

/** Antes de un cambio: `current` es lo que hay ahora. Con `key` (el campo que
 *  se está escribiendo), un cambio seguido al anterior en el mismo campo no
 *  abre paso nuevo. Cualquier cambio nuevo borra lo que se podía rehacer. */
export function recordStep<T>(h: EditHistory<T>, current: T, key: unknown, now: number): EditHistory<T> {
  const joins = key != null && key === h.key && now - h.at < COALESCE_MS;
  const past = joins ? h.past : [...h.past, current].slice(-HISTORY_MAX);
  return { past, future: [], key: key ?? null, at: now };
}

/** Vuelve un paso atrás. Null si no hay nada que deshacer. */
export function undoStep<T>(h: EditHistory<T>, current: T): { history: EditHistory<T>; value: T } | null {
  if (h.past.length === 0) return null;
  const value = h.past[h.past.length - 1];
  return { value, history: { past: h.past.slice(0, -1), future: [...h.future, current], key: null, at: 0 } };
}

/** Rehace lo último deshecho. Null si no hay nada. */
export function redoStep<T>(h: EditHistory<T>, current: T): { history: EditHistory<T>; value: T } | null {
  if (h.future.length === 0) return null;
  const value = h.future[h.future.length - 1];
  return { value, history: { past: [...h.past, current], future: h.future.slice(0, -1), key: null, at: 0 } };
}

/** Ctrl+Z / ⌘Z deshace; Ctrl+Mayús+Z, ⌘⇧Z y Ctrl+Y rehacen. */
export function historyCommand(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): 'deshacer' | 'rehacer' | null {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'rehacer' : 'deshacer';
  if (k === 'y' && e.ctrlKey && !e.shiftKey) return 'rehacer';
  return null;
}
