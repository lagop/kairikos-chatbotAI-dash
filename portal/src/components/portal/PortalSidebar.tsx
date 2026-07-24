import Link from 'next/link';
import type { ReactNode } from 'react';

export type PortalSidebarItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** When true the item renders as a placeholder that points to a "coming soon" page. */
  placeholder?: boolean;
  /** Optional badge text rendered to the right of the label (e.g. "Pronto"). */
  badge?: string;
};

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const ICONS = {
  home: (
    <svg {...ICON_PROPS}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
    </svg>
  ),
  chatbot: (
    <svg {...ICON_PROPS}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
    </svg>
  ),
  reviews: (
    <svg {...ICON_PROPS}>
      <path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5z" />
    </svg>
  ),
  billing: (
    <svg {...ICON_PROPS}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  ),
  account: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  ),
  support: (
    <svg {...ICON_PROPS}>
      <path d="M21 12a9 9 0 1 0-3.5 7.1" />
      <path d="M21 21v-5h-5" />
    </svg>
  ),
};

export const PORTAL_SIDEBAR_ITEMS: PortalSidebarItem[] = [
  { href: '/portal', label: 'Inicio', icon: ICONS.home },
  { href: '/portal/status', label: 'Chatbot', icon: ICONS.chatbot },
  {
    href: '/portal/resenas',
    label: 'Reseñas',
    icon: ICONS.reviews,
    placeholder: true,
    badge: 'Pronto',
  },
  {
    href: '/portal/facturacion',
    label: 'Facturación',
    icon: ICONS.billing,
    placeholder: true,
    badge: 'Pronto',
  },
  { href: '/portal/perfil', label: 'Mi cuenta', icon: ICONS.account },
  { href: '/portal/support', label: 'Soporte', icon: ICONS.support },
];

export function PortalSidebar({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Navegación lateral del portal"
      className="hidden w-60 shrink-0 border-r border-kairikos-border bg-kairikos-bg/60 px-3 py-6 lg:block"
      data-testid="portal-sidebar"
    >
      <ul className="space-y-1">
        {PORTAL_SIDEBAR_ITEMS.map((item) => {
          const isActive =
            item.href === '/portal'
              ? pathname === '/portal'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                aria-label={
                  item.placeholder ? `${item.label} (próximamente)` : item.label
                }
                data-testid={`sidebar-link-${item.href.replace(/\//g, '-')}`}
                data-placeholder={item.placeholder ? 'true' : undefined}
                className={[
                  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition',
                  isActive
                    ? 'bg-kairikos-surface text-kairikos-text'
                    : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
                  item.placeholder && !isActive ? 'opacity-90' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span
                  className={[
                    'grid h-8 w-8 place-items-center rounded-lg border',
                    isActive
                      ? 'border-kairikos-accent/40 bg-kairikos-accent/15 text-kairikos-accent'
                      : 'border-kairikos-border bg-kairikos-surface2 text-kairikos-muted group-hover:text-kairikos-text',
                  ].join(' ')}
                >
                  {item.icon}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge ? (
                  <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-kairikos-muted">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 px-3 text-[11px] leading-relaxed text-kairikos-muted">
        Las secciones marcadas como <span className="font-semibold text-kairikos-text">Pronto</span> forman parte del Dashboard v2 y se
        activarán en las próximas fases.
      </p>
    </nav>
  );
}
