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
  themeColor: '#0B1020',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-kairikos-bg text-kairikos-text">{children}</body>
    </html>
  );
}
