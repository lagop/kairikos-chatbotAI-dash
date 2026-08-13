import { redirect } from 'next/navigation';

// WP-05 — /portal/facturacion was a "coming soon" placeholder; the real
// billing page has lived at /portal/billing all along. The Stripe Billing
// Portal's return_url (stripe-billing.ts) has been repointed at /portal/billing
// directly, but this permanent redirect covers old bookmarks/links.
export default function PortalFacturacionPage() {
  redirect('/portal/billing');
}
