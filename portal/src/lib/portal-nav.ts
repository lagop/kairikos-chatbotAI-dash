// WP-04 — canonical portal navigation. PortalHeader and PortalSidebar
// previously kept two independent lists (NAV / PORTAL_SIDEBAR_ITEMS) that
// had already diverged: different labels and, worse, different hrefs for
// "Facturación" (the sidebar pointed at /portal/facturacion, the
// "Próximamente" placeholder — the header correctly pointed at the real
// /portal/billing page). This is the single source of truth both consume.
//
// Icons are not part of this module on purpose: they're a JSX concern
// (this file stays a plain .ts data module, no React import needed) and
// today only PortalSidebar renders them. PortalSidebar keeps its own
// href-keyed icon map.

export interface PortalNavItem {
  readonly href: string;
  readonly label: string;
  /** True for a route that exists but the product behind it isn't launched for every client yet. */
  readonly placeholder?: boolean;
  /** Short badge text shown next to the label, e.g. "Pronto". */
  readonly badge?: string;
  /**
   * href of this item's parent product section, e.g. Onboarding/Conversaciones
   * both belong under Chatbot (/portal/status). Only PortalSidebar groups by
   * this today — PortalHeader keeps rendering PORTAL_NAV as a flat row
   * (it's the only nav on tablet widths, where the sidebar is hidden, and a
   * flat pill row doesn't have room for a nested tree).
   */
  readonly parentHref?: string;
}

export const PORTAL_NAV: readonly PortalNavItem[] = [
  { href: '/portal', label: 'Resumen' },
  // Fase 5c — justo debajo del resumen y sin `parentHref`: el asistente
  // contesta sobre los datos de CUALQUIER producto, así que colgarlo de
  // uno de ellos daría a entender que solo sabe de ese.
  { href: '/portal/asistente', label: 'Asistente' },
  { href: '/portal/status', label: 'Chatbot' },
  { href: '/portal/onboarding', label: 'Onboarding', parentHref: '/portal/status' },
  { href: '/portal/conversations', label: 'Conversaciones', parentHref: '/portal/status' },
  // Fase 3 — la base de conocimiento es del chatbot y de nadie más, así que
  // cuelga de su sección igual que Onboarding y Canales.
  // La etiqueta es 'Conocimiento' y no 'Base de conocimiento' porque la
  // barra lateral trunca: la larga se veía «Base de conocimie…», que es
  // peor que la corta entera.
  { href: '/portal/conocimiento', label: 'Conocimiento', parentHref: '/portal/status' },
  { href: '/portal/canales', label: 'Canales', parentHref: '/portal/status' },
  { href: '/portal/web', label: 'Web' },
  // WP-XX — 'recall' is run entirely from WhatsApp and never requires a
  // login; this entry is here so an owner who WANTS to check the numbers
  // has somewhere to go, and so the portal home has a reason to show him
  // the rest of the catalogue while he is there. The page is read-only:
  // which calls became a job is decided by replying to the 19:00 digest.
  { href: '/portal/llamadas', label: 'Llamadas perdidas' },
  { href: '/portal/leads', label: 'Captación con IA' },
  { href: '/portal/seo', label: 'SEO con IA' },
  { href: '/portal/resenas', label: 'Reseñas' },
  { href: '/portal/billing', label: 'Facturación' },
  { href: '/portal/support', label: 'Soporte' },
] as const;

export const PORTAL_PROFILE_ITEM: PortalNavItem = { href: '/portal/perfil', label: 'Mi perfil' };

// Reserva propia para villas — la única entrada que NO es común a todos los
// clientes. El producto es un extra de Signature que activa el operador y
// tienen pocos, así que no está en PORTAL_NAV: enseñarlo a todos sería un
// enlace a «No está activa en tu cuenta» para casi cualquiera. Pero dejarlo
// fuera del todo (como nació) tenía un fallo peor: quien SÍ lo tiene solo
// llegaba al panel por el botón de un correo o escribiendo la URL. Ahora el
// layout pregunta si el cliente tiene la contratación y, si la tiene, la
// entrada sale justo debajo de «Web», que es con lo que se vende.
export const PORTAL_VILLAS_ITEM: PortalNavItem = { href: '/portal/villas', label: 'Reservas de villas' };

// Cartera de Signature inmobiliaria (19/11/2026) — mismo caso que villas: un
// extra de Signature que activa el operador. También va debajo de «Web»; si un
// cliente tuviera los dos, primero villas y después la cartera.
export const PORTAL_CARTERA_ITEM: PortalNavItem = { href: '/portal/cartera', label: 'Cartera' };

export interface PortalNavOptions {
  /** El cliente tiene la reserva de villas (activa, pausada o en el plazo de baja). */
  readonly villas?: boolean;
  /** El cliente tiene la cartera (activa, pausada o en el plazo de baja). */
  readonly cartera?: boolean;
}

/**
 * El menú de ESTE cliente: PORTAL_NAV más las entradas que dependen de lo que
 * tiene contratado. Cabecera, barra lateral y menú móvil pintan lo que
 * devuelve esta función, nunca PORTAL_NAV a secas, para que los tres sigan
 * enseñando lo mismo (el motivo de WP-04, arriba).
 */
export function portalNavFor(options: PortalNavOptions = {}): readonly PortalNavItem[] {
  const extra: PortalNavItem[] = [];
  if (options.villas) extra.push(PORTAL_VILLAS_ITEM);
  if (options.cartera) extra.push(PORTAL_CARTERA_ITEM);
  if (extra.length === 0) return PORTAL_NAV;
  const afterWeb = PORTAL_NAV.findIndex((item) => item.href === '/portal/web') + 1;
  // Si algún día «Web» sale de la lista, findIndex da -1 y la entrada va al
  // final; mejor ahí que encima de «Resumen».
  const at = afterWeb > 0 ? afterWeb : PORTAL_NAV.length;
  return [...PORTAL_NAV.slice(0, at), ...extra, ...PORTAL_NAV.slice(at)];
}
