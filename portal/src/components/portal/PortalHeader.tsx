import Link from 'next/link';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/portal', label: 'Resumen' },
  { href: '/portal/onboarding', label: 'Onboarding' },
  { href: '/portal/status', label: 'Chatbot' },
  { href: '/portal/conversations', label: 'Conversaciones' },
  { href: '/portal/billing', label: 'Facturación' },
  { href: '/portal/support', label: 'Soporte' },
] as const;

const PROFILE_HREF = '/portal/perfil';

export function PortalHeader({
  email,
  businessName,
  userMenu,
}: {
  email: string | null;
  businessName?: string;
  userMenu?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-kairikos-border bg-kairikos-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-page items-center justify-between gap-3 px-4 py-3 sm:px-6">
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
              className="rounded-lg px-3 py-1.5 text-sm text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          {email ? (
            <Link
              href={PROFILE_HREF}
              className="hidden text-xs text-kairikos-muted underline-offset-2 hover:text-kairikos-text hover:underline sm:inline"
              aria-label={`Ir al perfil de ${email}`}
              data-testid="header-profile-link"
            >
              <span className="sr-only">Sesión iniciada como</span>
              {email}
            </Link>
          ) : null}
          {userMenu}
        </div>
      </div>
      <nav aria-label="Navegación móvil" className="border-t border-kairikos-border/60 sm:hidden">
        <ul className="mx-auto flex max-w-page gap-1 overflow-x-auto px-4 py-2 text-sm">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="block whitespace-nowrap rounded-lg px-3 py-1.5 text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text"
              >
                {item.label}
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
