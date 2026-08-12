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
}

export const PORTAL_NAV: readonly PortalNavItem[] = [
  { href: '/portal', label: 'Resumen' },
  { href: '/portal/onboarding', label: 'Onboarding' },
  { href: '/portal/status', label: 'Chatbot' },
  { href: '/portal/conversations', label: 'Conversaciones' },
  { href: '/portal/resenas', label: 'Reseñas' },
  { href: '/portal/billing', label: 'Facturación' },
  { href: '/portal/support', label: 'Soporte' },
] as const;

export const PORTAL_PROFILE_ITEM: PortalNavItem = { href: '/portal/perfil', label: 'Mi perfil' };
