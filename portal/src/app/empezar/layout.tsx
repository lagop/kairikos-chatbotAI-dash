import type { Metadata } from 'next';

const TITLE = 'Crea tu cuenta — Kairikos';
const DESCRIPTION = 'Date de alta y contrata tu producto Kairikos directamente, sin esperar a nadie.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', locale: 'es_ES', siteName: 'Kairikos' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
  alternates: { canonical: '/empezar' },
};

export default function EmpezarLayout({ children }: { children: React.ReactNode }) {
  return children;
}
