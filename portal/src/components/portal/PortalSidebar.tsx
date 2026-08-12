import Link from 'next/link';
import type { ReactNode } from 'react';
import { PORTAL_NAV, PORTAL_PROFILE_ITEM, type PortalNavItem } from '@/lib/portal-nav';

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

// WP-04 — keyed by href (not an arbitrary name) so it stays aligned with
// PORTAL_NAV by construction: a missing entry falls back to a neutral dot
// instead of silently rendering nothing.
const ICON_BY_HREF: Record<string, ReactNode> = {
  '/portal': (
    <svg {...ICON_PROPS}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
    </svg>
  ),
  '/portal/onboarding': (
    <svg {...ICON_PROPS}>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 3.2h6a1 1 0 0 1 1 1V6H8V4.2a1 1 0 0 1 1-1z" />
      <path d="M9 12.5l1.8 1.8L15 10.5" />
    </svg>
  ),
  '/portal/status': (
    <svg {...ICON_PROPS}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
    </svg>
  ),
  '/portal/conversations': (
    <svg {...ICON_PROPS}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7z" />
    </svg>
  ),
  '/portal/resenas': (
    <svg {...ICON_PROPS}>
      <path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5z" />
    </svg>
  ),
  '/portal/billing': (
    <svg {...ICON_PROPS}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  ),
  '/portal/support': (
    <svg {...ICON_PROPS}>
      <path d="M21 12a9 9 0 1 0-3.5 7.1" />
      <path d="M21 21v-5h-5" />
    </svg>
  ),
  '/portal/perfil': (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  ),
};

const FALLBACK_ICON = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

// The profile item is a separate account-level link, not a portal
// "section" — appended after PORTAL_NAV rather than folded into it, same
// way the header treats it (its own dropdown/mobile entry, not one of the
// main nav pills).
const SIDEBAR_ITEMS: readonly PortalNavItem[] = [...PORTAL_NAV, PORTAL_PROFILE_ITEM];

export function PortalSidebar({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Navegación lateral del portal"
      className="hidden w-60 shrink-0 border-r border-kairikos-border bg-kairikos-bg/60 px-3 py-6 lg:block"
      data-testid="portal-sidebar"
    >
      <ul className="space-y-1">
        {SIDEBAR_ITEMS.map((item) => {
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
                  {ICON_BY_HREF[item.href] ?? FALLBACK_ICON}
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
      {SIDEBAR_ITEMS.some((item) => item.badge) ? (
        <p className="mt-6 px-3 text-[11px] leading-relaxed text-kairikos-muted">
          Las secciones marcadas como <span className="font-semibold text-kairikos-text">Pronto</span> forman parte del Dashboard v2 y se
          activarán en las próximas fases.
        </p>
      ) : null}
    </nav>
  );
}
