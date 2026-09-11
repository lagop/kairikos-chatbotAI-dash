import type { Metadata } from 'next';
import Link from 'next/link';
import { PortalFooter } from '@/components/portal/PortalFooter';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

export const metadata: Metadata = {
  title: 'Admin',
  description: 'Vista de soporte para el equipo operador.',
  alternates: { canonical: '/admin/portal/clients' },
  robots: { index: false, follow: false },
};

// Barra lateral persistente (WP-XX) — antes, 9 de los ~14 destinos del
// panel solo se alcanzaban desde un cinturón de botones metido en
// /admin/portal/clients, y otros tres (flows, wizard-funnel,
// settings/security) no tenían ningún enlace visible en absoluto. Los
// datos de la navegación viven en lib/admin-nav.ts — un solo sitio,
// consumido tanto por la versión de escritorio como por el desplegable
// de móvil dentro de AdminSidebar.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-kairikos-border bg-kairikos-bg">
        <div className="mx-auto flex max-w-page items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/admin/portal/clients" className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-lg bg-kairikos-accent2 text-sm font-bold text-kairikos-bg"
            >
              O
            </span>
            <span className="text-sm font-semibold tracking-tight">
              Kairikos · Vista de soporte
            </span>
          </Link>
          <nav aria-label="Acciones" className="flex items-center gap-2 text-sm">
<form action="/admin/logout" method="post" className="inline">
              <button type="submit" className="text-kairikos-muted hover:text-kairikos-text">
                Salir del modo soporte
              </button>
            </form>
          </nav>
        </div>
      </header>
      <div className="flex flex-1">
        <AdminSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </div>
      <PortalFooter />
    </div>
  );
}
