import Link from 'next/link';
import { PORTAL_NAV, PORTAL_PROFILE_ITEM, type PortalNavItem } from '@/lib/portal-nav';
import { ICON_BY_HREF, FALLBACK_ICON } from '@/components/portal/portal-nav-icons';

// The profile item is a separate account-level link, not a portal
// "section" — appended after PORTAL_NAV rather than folded into it, same
// way the header treats it (its own dropdown/mobile entry, not one of the
// main nav pills).
const SIDEBAR_ITEMS: readonly PortalNavItem[] = [...PORTAL_NAV, PORTAL_PROFILE_ITEM];

function isItemActive(item: PortalNavItem, pathname: string): boolean {
  return item.href === '/portal'
    ? pathname === '/portal'
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

// Onboarding/Conversaciones render nested under Chatbot (their parentHref)
// instead of as siblings — they're chatbot-specific, not their own portal
// sections. Only PortalSidebar groups this way; PortalHeader's flat pill
// row on tablet keeps PORTAL_NAV's declaration order as-is.
function SidebarLink({ item, pathname, nested }: { item: PortalNavItem; pathname: string; nested?: boolean }) {
  const isActive = isItemActive(item, pathname);
  return (
    <Link
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      aria-label={item.placeholder ? `${item.label} (próximamente)` : item.label}
      data-testid={`sidebar-link-${item.href.replace(/\//g, '-')}`}
      data-placeholder={item.placeholder ? 'true' : undefined}
      className={[
        'group flex items-center gap-3 rounded-xl text-sm transition',
        nested ? 'py-2 pl-2 pr-3' : 'px-3 py-2.5',
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
          'grid place-items-center rounded-lg border',
          nested ? 'h-6 w-6' : 'h-8 w-8',
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
  );
}

export function PortalSidebar({ pathname }: { pathname: string }) {
  const topLevelItems = SIDEBAR_ITEMS.filter((item) => !item.parentHref);

  return (
    <nav
      aria-label="Navegación lateral del portal"
      className="hidden w-60 shrink-0 border-r border-kairikos-border bg-kairikos-bg/60 px-3 py-6 lg:block"
      data-testid="portal-sidebar"
    >
      <ul className="space-y-1">
        {topLevelItems.map((item) => {
          const children = SIDEBAR_ITEMS.filter((child) => child.parentHref === item.href);
          return (
            <li key={item.href}>
              <SidebarLink item={item} pathname={pathname} />
              {children.length > 0 ? (
                <ul className="ml-4 mt-1 space-y-1 border-l border-kairikos-border/60 pl-3">
                  {children.map((child) => (
                    <li key={child.href}>
                      <SidebarLink item={child} pathname={pathname} nested />
                    </li>
                  ))}
                </ul>
              ) : null}
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
