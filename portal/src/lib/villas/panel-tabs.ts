// =============================================================================
// Reserva propia para villas — las pestañas del panel del dueño.
//
// El panel nació como una sola página con nueve bloques seguidos: lo urgente
// (solicitudes por responder) compartía scroll con lo que se toca una vez (la
// clave de Stripe, el código para pegar en la web). Ahora son cuatro pestañas.
//
// Módulo aparte y sin 'server-only' a propósito: lo leen la página (para
// decidir la pestaña inicial desde ?seccion=) y el componente de cliente, y así
// la regla de qué vale como pestaña se puede testear sin DOM.
//
// La pestaña por defecto es «reservas» y NO lleva parámetro en la URL: los
// correos al dueño enlazan /portal/villas a secas y tienen que seguir cayendo
// en las solicitudes.
// =============================================================================

// `short` es la etiqueta en móvil. Con las largas, a 360 px la cuarta pestaña
// quedaba fuera de la fila, detrás de un scroll horizontal que en un móvil no
// enseña barra: existía pero no se descubría. Las cortas caben las cuatro.
export const VILLAS_TABS = [
  { id: 'reservas', label: 'Reservas', short: 'Reservas' },
  { id: 'villas', label: 'Villas', short: 'Villas' },
  { id: 'cobros', label: 'Cobros y condiciones', short: 'Cobros' },
  { id: 'web', label: 'Tu web y tus datos', short: 'Web y datos' },
] as const;

export type VillasTabId = (typeof VILLAS_TABS)[number]['id'];

export const DEFAULT_VILLAS_TAB: VillasTabId = 'reservas';

/** El nombre del parámetro de la URL: /portal/villas?seccion=cobros */
export const VILLAS_TAB_PARAM = 'seccion';

/** De lo que venga en ?seccion= (nada, repetido, inventado) a una pestaña que existe. */
export function parseVillasTab(value: string | string[] | null | undefined): VillasTabId {
  const raw = Array.isArray(value) ? value[0] : value;
  const found = VILLAS_TABS.find((t) => t.id === raw);
  return found ? found.id : DEFAULT_VILLAS_TAB;
}

/** La URL de una pestaña. La de por defecto es la ruta limpia. */
export function villasTabHref(tab: VillasTabId, pathname = '/portal/villas'): string {
  return tab === DEFAULT_VILLAS_TAB ? pathname : `${pathname}?${VILLAS_TAB_PARAM}=${tab}`;
}

/**
 * El número del contador de «Reservas». A 360 px las cuatro pestañas caben
 * justas con un contador de una cifra; con dos, la cuarta volvía a quedar
 * fuera de la fila. El número exacto sigue en el aria-label y en el título de
 * la sección.
 */
export function pendingBadgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** La pestaña vecina para las flechas del teclado; da la vuelta en los extremos. */
export function neighbourVillasTab(current: VillasTabId, step: 1 | -1): VillasTabId {
  const i = VILLAS_TABS.findIndex((t) => t.id === current);
  return VILLAS_TABS[(i + step + VILLAS_TABS.length) % VILLAS_TABS.length].id;
}
