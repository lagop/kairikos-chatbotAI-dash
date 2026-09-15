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
  // Fase 5a — iOS NO lee el manifest para el icono de la pantalla de
  // inicio: usa apple-touch-icon, y sin él captura un pantallazo de la
  // página y lo usa de icono. Importa más de lo que parece, porque Safari
  // solo permite notificaciones push desde una PWA ya instalada — en
  // iPhone, este icono es el paso previo a que las push existan.
  //
  // El manifest se declara aquí y no con un <link> a mano para que Next
  // resuelva la ruta él mismo (la genera src/app/manifest.ts).
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    // Lo que hace que, una vez añadida a la pantalla de inicio, iOS la
    // abra SIN la barra de Safari. Sin esto se instala el acceso directo
    // pero sigue abriéndose como una pestaña más.
    capable: true,
    title: 'Kairikos',
    statusBarStyle: 'default',
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
