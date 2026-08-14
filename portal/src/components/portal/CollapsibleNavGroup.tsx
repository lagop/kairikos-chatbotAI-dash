'use client';

import { useEffect, useState, type ReactNode } from 'react';

// Shared by PortalSidebar (desktop) and PortalMobileNav (drawer) — any nav
// item with children (e.g. Chatbot > Onboarding/Conversaciones) renders
// through here instead of always showing its children inline. Collapsed
// by default; auto-opens when the current route is one of its children
// (so arriving via a direct link or bookmark doesn't hide where you are),
// but a manual toggle-open never auto-closes just because the route
// changed elsewhere. Without this, every future product with its own
// sub-pages permanently lengthens the main menu — the whole point of
// making it collapsible in the first place.
export function CollapsibleNavGroup({
  testId,
  hasActiveChild,
  trigger,
  toggleLabel,
  children,
}: {
  // Full data-testid for the toggle button, supplied by the caller (not
  // derived here from a bare href/key) — PortalSidebar's desktop nav
  // stays in the DOM even at mobile widths (hidden via CSS, not
  // unmounted), so its group toggle and PortalMobileNav's drawer toggle
  // for the same item coexist simultaneously. A shared derivation would
  // give both the same testid, and a naive querySelector/locator picks
  // whichever comes first in DOM order — which, at mobile widths, is the
  // invisible desktop one.
  testId: string;
  hasActiveChild: boolean;
  trigger: ReactNode;
  toggleLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(hasActiveChild);

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  return (
    <>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">{trigger}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={toggleLabel}
          data-testid={testId}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {open ? children : null}
    </>
  );
}
