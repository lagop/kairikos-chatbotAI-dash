import { permanentRedirect } from 'next/navigation';

// =============================================================================
// WP-17 — DEPRECATED. This route was never linked from PORTAL_NAV (the
// WP-04 canonical nav list) or anywhere else in the app; /portal (root,
// labeled "Resumen") is the real, nav-linked client summary screen and
// always has been. dashboard-data.ts's getDashboardData() — built here
// under WP-08 — now backs /portal directly instead. Redirecting rather
// than deleting the route outright in case anything external (an old
// bookmark, an email link) still points at /portal/dashboard.
// =============================================================================

export default function LegacyDashboardRedirect() {
  permanentRedirect('/portal');
}
