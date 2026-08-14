'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PORTAL_NAV, PORTAL_PROFILE_ITEM, type PortalNavItem } from '@/lib/portal-nav';
import { ICON_BY_HREF, FALLBACK_ICON } from '@/components/portal/portal-nav-icons';
import { CollapsibleNavGroup } from '@/components/portal/CollapsibleNavGroup';

// Replaces the old horizontal-scroll pill row (sm:hidden — mobile only).
// That row had no visual cue that "Perfil" (and sometimes "Soporte") sat
// past the fold, scrollable but not discoverable. A hamburger drawer
// fixes that, and reuses the same Chatbot > Onboarding/Conversaciones
// grouping PortalSidebar already renders on desktop instead of a flat
// list — one hierarchy, two presentations.
const MOBILE_NAV_ITEMS: readonly PortalNavItem[] = [...PORTAL_NAV, PORTAL_PROFILE_ITEM];

function isItemActive(item: PortalNavItem, pathname: string): boolean {
  return item.href === '/portal'
    ? pathname === '/portal'
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function DrawerLink({
  item,
  pathname,
  nested,
  onNavigate,
}: {
  item: PortalNavItem;
  pathname: string;
  nested?: boolean;
  onNavigate: () => void;
}) {
  const isActive = isItemActive(item, pathname);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      data-testid={`header-nav-${item.href.replace(/\//g, '-')}`}
      className={[
        'flex items-center gap-3 rounded-xl text-sm transition',
        nested ? 'py-2 pl-2 pr-3' : 'px-3 py-2.5',
        isActive
          ? 'bg-kairikos-surface text-kairikos-text'
          : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
      ].join(' ')}
    >
      <span
        className={[
          'grid place-items-center rounded-lg border',
          nested ? 'h-6 w-6' : 'h-8 w-8',
          isActive
            ? 'border-kairikos-accent/40 bg-kairikos-accent/15 text-kairikos-accent'
            : 'border-kairikos-border bg-kairikos-surface2 text-kairikos-muted',
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

export function PortalMobileNav() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-close on route change (covers tapping any link inside) and
  // whenever the drawer is open, lock body scroll and let Escape close
  // it — a full-screen overlay left open behind a new page, or one that
  // traps scroll with no keyboard escape, is a worse regression than the
  // scroll row it replaces.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="portal-mobile-nav-panel"
        aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
        data-testid="mobile-nav-trigger"
        className="grid h-9 w-9 place-items-center rounded-lg text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" />
          ) : (
            <>
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </>
          )}
        </svg>
      </button>

      {mounted && open
        ? createPortal(
            // Portaled to document.body rather than rendered inline here.
            // The header has `backdrop-blur` (backdrop-filter), and in
            // Chromium a non-none backdrop-filter establishes a containing
            // block for `position: fixed` descendants — same as
            // `transform` does. Nested inside <header>, this backdrop and
            // panel sized themselves against the header's own ~60px box
            // instead of the viewport (confirmed via
            // getBoundingClientRect: height came back as the header's
            // height, not the screen's). Escaping via a portal is the
            // standard fix for exactly this class of bug.
            <>
              <div
                aria-hidden
                data-testid="mobile-nav-backdrop"
                className="fixed inset-0 z-20 bg-black/50"
                onClick={() => setOpen(false)}
              />
              <div
                id="portal-mobile-nav-panel"
                role="dialog"
                aria-label="Menú de navegación"
                data-testid="mobile-nav-panel"
                className="fixed inset-x-0 top-[57px] z-30 max-h-[calc(100vh-57px)] overflow-y-auto border-t border-kairikos-border bg-kairikos-bg px-4 py-4 shadow-xl"
              >
                <ul className="space-y-1">
                  {MOBILE_NAV_ITEMS.filter((item) => !item.parentHref).map((item) => {
                    const children = MOBILE_NAV_ITEMS.filter((child) => child.parentHref === item.href);
                    if (children.length === 0) {
                      return (
                        <li key={item.href}>
                          <DrawerLink item={item} pathname={pathname} onNavigate={() => setOpen(false)} />
                        </li>
                      );
                    }
                    return (
                      <li key={item.href}>
                        <CollapsibleNavGroup
                          testId={`mobile-nav-group-toggle-${item.href.replace(/\//g, '-')}`}
                          hasActiveChild={children.some((child) => isItemActive(child, pathname))}
                          trigger={<DrawerLink item={item} pathname={pathname} onNavigate={() => setOpen(false)} />}
                          toggleLabel={`Subsecciones de ${item.label}`}
                        >
                          <ul className="ml-4 mt-1 space-y-1 border-l border-kairikos-border/60 pl-3">
                            {children.map((child) => (
                              <li key={child.href}>
                                <DrawerLink item={child} pathname={pathname} nested onNavigate={() => setOpen(false)} />
                              </li>
                            ))}
                          </ul>
                        </CollapsibleNavGroup>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
