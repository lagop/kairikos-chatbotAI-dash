import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com'),
  title: {
    default: 'Portal Kairikos',
    template: '%s · Portal Kairikos',
  },
  description:
    'Tu portal de cliente Kairikos: sigue el onboarding de tu chatbot de IA, consulta conversaciones, facturación y soporte.',
  openGraph: {
    title: 'Portal Kairikos',
    description:
      'Sigue el estado de tu chatbot de IA, conversaciones recientes, facturación y soporte.',
    siteName: 'Kairikos',
    type: 'website',
    locale: 'es_ES',
  },
  robots: {
    index: false,
    follow: false,
  },
};

// WP-32 — light is the default regardless of OS preference (see
// globals.css), so the mobile browser-chrome color follows suit: a
// single fixed value, not the old light/dark media-query pair. This
// meta tag is static (Next's metadata API, not reactive to the
// client-side data-theme attribute ThemeToggle.tsx writes), so a
// visitor who explicitly toggles to dark keeps a light-colored chrome
// bar against a dark page — the same class of small mismatch the old
// OS-driven pair already had for an explicit-choice visitor, not a new
// gap this introduces.
export const viewport: Viewport = {
  themeColor: '#F3F4FA',
  width: 'device-width',
  initialScale: 1,
};

// WP-27/32 — runs before hydration so a returning visitor who chose
// "dark" never sees a flash of the light default. Deliberately does
// nothing when no preference is stored: :root in globals.css is
// already light by default, with no JS involved.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('kairikos-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-kairikos-bg text-kairikos-text">{children}</body>
    </html>
  );
}
