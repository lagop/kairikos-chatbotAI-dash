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

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F3F4FA' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1020' },
  ],
  width: 'device-width',
  initialScale: 1,
};

// WP-27 — runs before hydration so a returning visitor who chose "light"
// never sees a flash of the dark default. Deliberately does nothing when
// no preference is stored: the @media(prefers-color-scheme) rule in
// globals.css already renders the OS-appropriate theme for a first-time
// visitor without any JS involved.
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
