import Link from 'next/link';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/portal', label: 'Resumen' },
  { href: '/portal/onboarding', label: 'Onboarding' },
  { href: '/portal/status', label: 'Chatbot' },
  { href: '/portal/conversations', label: 'Conversaciones' },
  { href: '/portal/resenas', label: 'Reseñas' },
  { href: '/portal/billing', label: 'Facturación' },
  { href: '/portal/support', label: 'Soporte' },
] as const;

const PROFILE_HREF = '/portal/perfil';

// WP-01/WP-04 — no NAV item declares a `badge` field today, so `item.badge`
// types as `{}`, not `ReactNode`. `@ts-expect-error` can't target a JSX
// child expression directly (a known TS limitation), so the suppression
// lives here instead. Dead branch — WP-04's nav consolidation resolves it
// for real once a NAV item actually needs a badge.
function navItemBadge(item: (typeof NAV)[number]): ReactNode | null {
  // @ts-expect-error WP-01/WP-04 — see the note above this function.
  return 'badge' in item && item.badge ? item.badge : null;
}

export function PortalHeader({
  email,
  businessName,
}: {
  email: string | null;
  businessName?: string;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-kairikos-border bg-kairikos-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-page items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Link href="/portal" className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-lg bg-kairikos-accent text-sm font-bold"
            >
              K
            </span>
            <span className="text-sm font-semibold tracking-tight">Portal Kairikos</span>
          </Link>
          {businessName ? (
            <span className="ml-2 hidden text-sm text-kairikos-muted sm:inline" data-testid="header-company-name">
              · {businessName}
            </span>
          ) : null}
        </div>
        <nav aria-label="Navegación principal" className="hidden gap-1 sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`header-nav-${item.href.replace(/\//g, '-')}`}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
            >
              <span>{item.label}</span>
              {navItemBadge(item) ? (
                <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-kairikos-muted">
                  {navItemBadge(item)}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
        {email ? <UserMenu email={email} businessName={businessName} /> : null}
      </div>
      <nav aria-label="Navegación móvil" className="border-t border-kairikos-border/60 sm:hidden">
        <ul className="mx-auto flex max-w-page gap-1 overflow-x-auto px-4 py-2 text-sm">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={`header-nav-${item.href.replace(/\//g, '-')}`}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text"
              >
                <span>{item.label}</span>
                {navItemBadge(item) ? (
                  <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-kairikos-muted">
                    {navItemBadge(item)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href={PROFILE_HREF}
              className="block whitespace-nowrap rounded-lg px-3 py-1.5 text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text"
              data-testid="header-profile-link-mobile"
            >
              Perfil
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

function UserMenu({ email, businessName }: { email: string; businessName?: string }) {
  const initials = (businessName ?? email).trim().slice(0, 1).toUpperCase() || 'K';
  return (
    <details
      data-testid="header-profile"
      className="relative hidden text-sm sm:block"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
        data-testid="header-profile-trigger"
      >
        <span
          aria-hidden
          className="grid h-7 w-7 place-items-center rounded-full bg-kairikos-surface2 text-xs font-semibold text-kairikos-text"
        >
          {initials}
        </span>
        <span className="hidden max-w-[180px] truncate md:inline" data-testid="header-profile-email">
          {email}
        </span>
        <span aria-hidden className="text-xs">▾</span>
      </summary>
      <div
        role="menu"
        className="absolute right-0 mt-2 w-64 origin-top-right rounded-xl border border-kairikos-border bg-kairikos-surface p-3 shadow-xl"
        data-testid="header-profile-panel"
      >
        <div className="border-b border-kairikos-border/60 pb-2">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Sesión iniciada como</p>
          <p className="mt-1 break-all text-sm font-medium text-kairikos-text" data-testid="header-profile-email-full">
            {email}
          </p>
          {businessName ? (
            <p className="mt-2 text-xs text-kairikos-muted">
              Empresa: <span className="text-kairikos-text">{businessName}</span>
            </p>
          ) : null}
        </div>
        <div className="space-y-1 pt-2">
          <Link
            href={PROFILE_HREF}
            className="block rounded-lg px-3 py-2 text-sm text-kairikos-muted transition hover:bg-kairikos-surface2 hover:text-kairikos-text"
            data-testid="header-profile-link"
            role="menuitem"
          >
            Mi perfil
          </Link>
          <form action="/api/portal/logout" method="post">
            <button
              type="submit"
              className="block w-full rounded-lg px-3 py-2 text-left text-sm text-kairikos-muted transition hover:bg-kairikos-surface2 hover:text-kairikos-text"
              data-testid="header-logout"
              formMethod="post"
              role="menuitem"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}
