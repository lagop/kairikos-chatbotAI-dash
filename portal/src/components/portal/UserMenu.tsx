'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { PORTAL_PROFILE_ITEM } from '@/lib/portal-nav';

// Bug found 2026-08-21 via manual QA: the profile dropdown (a native
// <details>/<summary>, no JS) only closed on a second click of its own
// trigger — native <details> has no built-in "close on click outside"
// behavior, that's not a framework bug, it's just not something plain
// HTML does. Fix: keep the <details> element (still the toggle-open
// mechanism, still keyboard-operable for free) but add a document-level
// mousedown listener that closes it when the click lands outside the
// element. mousedown (not click) so this resolves before whatever the
// outside target's own click handler does, matching the usual
// dropdown-close convention.
export function UserMenu({ email, businessName }: { email: string; businessName?: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const initials = (businessName ?? email).trim().slice(0, 1).toUpperCase() || 'K';

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      const el = detailsRef.current;
      if (!el || !el.open) return;
      if (event.target instanceof Node && !el.contains(event.target)) {
        el.open = false;
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  return (
    <details ref={detailsRef} data-testid="header-profile" className="relative hidden text-sm sm:block">
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
            href={PORTAL_PROFILE_ITEM.href}
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
