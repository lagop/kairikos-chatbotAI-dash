import type { Metadata } from 'next';
import Link from 'next/link';
import { PortalFooter } from '@/components/portal/PortalFooter';

export const metadata: Metadata = {
  title: 'Admin',
  description: 'Vista de soporte para el equipo operador.',
  alternates: { canonical: '/admin/portal/clients' },
  robots: { index: false, follow: false },
};

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
      <main className="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <PortalFooter />
    </div>
  );
}
