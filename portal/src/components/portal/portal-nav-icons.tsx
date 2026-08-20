import type { ReactNode } from 'react';

// Extracted from PortalSidebar (WP-04) so PortalMobileNav's drawer can use
// the exact same icon set instead of re-drawing its own — one visual
// vocabulary for "what does this section look like" across desktop
// sidebar and mobile drawer.

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

// Keyed by href (not an arbitrary name) so it stays aligned with
// PORTAL_NAV by construction: a missing entry falls back to a neutral dot
// instead of silently rendering nothing.
export const ICON_BY_HREF: Record<string, ReactNode> = {
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
  '/portal/canales': (
    <svg {...ICON_PROPS}>
      <path d="M9 3v4M15 3v4" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0V7z" />
      <path d="M12 17v4" />
      <path d="M9 21h6" />
    </svg>
  ),
  '/portal/web': (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 4 5.8 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.8-4-9s1.5-6.5 4-9z" />
    </svg>
  ),
  '/portal/leads': (
    <svg {...ICON_PROPS}>
      <path d="M4 4.5h16l-6.2 8v6l-3.6 1.8v-7.8L4 4.5z" strokeLinejoin="round" />
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

export const FALLBACK_ICON = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);
