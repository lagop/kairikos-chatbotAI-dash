import { redirect } from 'next/navigation';

// WP-06 — /admin/portal and /admin/portal/clients were two independent
// client-listing pages with diverging data paths: this one re-implemented
// the Prisma read inline (a plain `goLiveAt ? 'live' : 'in_progress'`
// guess standing in for the real onboarding status, no slug), while
// /admin/portal/clients already went through the shared, hardened
// listAdminClients() (KAIA-13702/13715 — the exact "same page copied
// twice, one copy drifts" incident class this WP exists to close off).
// /admin/portal/clients is the survivor; this becomes a permanent
// redirect so old links and admin/page.tsx's post-login destination
// still land somewhere real.
export default function AdminPortalIndexPage() {
  redirect('/admin/portal/clients');
}
