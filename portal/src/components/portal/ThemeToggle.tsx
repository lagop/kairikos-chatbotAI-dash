'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'kairikos-theme';
// PortalHeader and PortalSidebar each mount their own <ThemeToggle>. A
// click in one has to update the other's label/icon too, and neither
// storage events (same-tab writes don't fire them) nor a shared context
// (would mean threading a provider through two independent server-rendered
// trees) cover that — so every instance broadcasts this event and every
// instance listens for it.
const THEME_CHANGE_EVENT = 'kairikos-theme-change';
type Theme = 'light' | 'dark';

// Mirrors the fallback order the blocking script in layout.tsx and the
// @media query in globals.css already apply: an explicit data-theme
// attribute wins, otherwise fall back to the OS preference.
function getEffectiveTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ThemeToggle({ className }: { className?: string }) {
  // Starts null so the server-rendered markup and the first client render
  // match (the server has no way to know the visitor's theme); the real
  // icon appears a frame later once the effect below reads the DOM.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(getEffectiveTheme());
    const onThemeChange = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);

  function toggle() {
    const next: Theme = (theme ?? getEffectiveTheme()) === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode/disabled storage: the toggle still works for this
      // tab via the dataset attribute, it just won't persist across visits.
    }
    setTheme(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }

  if (theme === null) {
    return <span aria-hidden className={className ?? 'block h-9 w-9'} />;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="theme-toggle"
      aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
      title={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
      className={
        className ??
        'grid h-9 w-9 place-items-center rounded-lg text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text'
      }
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" />
    </svg>
  );
}
