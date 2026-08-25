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
  { href: '/portal/status', label: 'Chatbot' },
  { href: '/portal/onboarding', label: 'Onboarding', parentHref: '/portal/status' },
  { href: '/portal/conversations', label: 'Conversaciones', parentHref: '/portal/status' },
  { href: '/portal/canales', label: 'Canales', parentHref: '/portal/status' },
  { href: '/portal/web', label: 'Web' },
  // WP-XX — 'recall' is run entirely from WhatsApp and never requires a
  // login; this entry is here so an owner who WANTS to check the numbers
  // has somewhere to go, and so the portal home has a reason to show him
  // the rest of the catalogue while he is there. The page is read-only:
  // which calls became a job is decided by replying to the 19:00 digest.
  { href: '/portal/llamadas', label: 'Llamadas perdidas' },
  { href: '/portal/leads', label: 'Captación con IA' },
  { href: '/portal/resenas', label: 'Reseñas' },
  { href: '/portal/billing', label: 'Facturación' },
  { href: '/portal/support', label: 'Soporte' },
] as const;

export const PORTAL_PROFILE_ITEM: PortalNavItem = { href: '/portal/perfil', label: 'Mi perfil' };
