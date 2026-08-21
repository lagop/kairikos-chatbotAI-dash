import Link from 'next/link';
import { PORTAL_NAV } from '@/lib/portal-nav';
import { ThemeToggle } from '@/components/portal/ThemeToggle';
import { PortalMobileNav } from '@/components/portal/PortalMobileNav';
import { UserMenu } from '@/components/portal/UserMenu';

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
        <div className="flex items-center gap-1">
          <PortalMobileNav />
          <ThemeToggle />
          {email ? <UserMenu email={email} businessName={businessName} /> : null}
        </div>
      </div>
      {/* Only source of primary nav on tablet widths (640–1023px), where
          PortalSidebar is hidden (lg:block) — hidden again at lg, where the
          sidebar takes over (showing both was a duplicate menu). Its own
          full-width row rather than squeezed into the flex row above:
          logo + company name + nav + theme + profile all in one row
          overflowed the header at 768–1023px (confirmed: page needed
          ~1120px). A dedicated row can never compete with the rest of the
          header for horizontal space, same reasoning as the mobile nav
          row below. */}
      <nav aria-label="Navegación principal" className="hidden border-t border-kairikos-border/60 sm:block lg:hidden">
        <ul className="mx-auto flex max-w-page gap-1 overflow-x-auto px-4 py-2 sm:px-6">
          {PORTAL_NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={`header-nav-${item.href.replace(/\//g, '-')}`}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-kairikos-muted">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
