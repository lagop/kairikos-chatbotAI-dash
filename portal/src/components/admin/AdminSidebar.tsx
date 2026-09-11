'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ADMIN_NAV, type AdminNavItem } from '@/lib/admin-nav';

// =============================================================================
// Barra lateral del panel de operador. Mismo patrón que
// components/portal/PortalSidebar.tsx (datos en un módulo aparte,
// resaltado por ruta activa) — sin el anidado de esa, porque aquí los
// grupos son etiquetas de categoría (Clientes, Bandejas de trabajo…),
// no páginas propias con hijos.
//
// Un solo componente para escritorio y móvil: en escritorio es una
// barra fija (`lg:block`); en móvil, la misma lista dentro de un
// <details> nativo en la cabecera — sin JS de apertura/cierre propio,
// el navegador ya lo resuelve.
// =============================================================================

function isItemActive(item: AdminNavItem, pathname: string): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="space-y-5">
      {ADMIN_NAV.map((group) => (
        <li key={group.label}>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-kairikos-muted">{group.label}</p>
          <ul className="mt-2 space-y-1">
            {group.items.map((item) => {
              const isActive = isItemActive(item, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`admin-sidebar-link-${item.href.replace(/\//g, '-')}`}
                    onClick={onNavigate}
                    className={[
                      'block rounded-xl px-3 py-2 text-sm transition',
                      isActive
                        ? 'bg-kairikos-surface text-kairikos-text font-medium'
                        : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
                    ].join(' ')}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function AdminSidebar() {
  const pathname = usePathname() ?? '/admin/portal/clients';

  return (
    <>
      {/* Escritorio — barra fija */}
      <nav
        aria-label="Navegación del panel de operador"
        className="hidden w-60 shrink-0 border-r border-kairikos-border bg-kairikos-bg/60 px-3 py-6 lg:block"
        data-testid="admin-sidebar"
      >
        <NavList pathname={pathname} />
      </nav>

      {/* Móvil/tablet — desplegable nativo, sin duplicar el estado en JS */}
      <details className="border-b border-kairikos-border bg-kairikos-bg lg:hidden" data-testid="admin-sidebar-mobile">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-kairikos-text marker:hidden">
          <span className="inline-flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Menú
          </span>
        </summary>
        <div className="border-t border-kairikos-border px-3 py-4">
          <NavList pathname={pathname} />
        </div>
      </details>
    </>
  );
}
