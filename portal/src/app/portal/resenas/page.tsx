import type { Metadata } from 'next';
import { PortalPlaceholderPage } from '@/components/portal/PortalPlaceholderPage';

export const metadata: Metadata = {
  title: 'Reseñas · Próximamente',
  description:
    'La sección de Reseñas de Google del portal Kairikos está en preparación. Llegará con la Fase 2 del Dashboard v2.',
  alternates: { canonical: '/portal/resenas' },
  robots: { index: false, follow: false },
};

const STAR_ICON = (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5z" />
  </svg>
);

export default function PortalResenasPage() {
  return (
    <PortalPlaceholderPage
      eyebrow="Reseñas"
      title="Gestiona las reseñas de Google de tu negocio"
      description="Pronto podrás ver y responder tus reseñas de Google, automatizar solicitudes tras cada venta y analizar tu reputación desde un solo lugar."
      phase="2 del Dashboard v2"
      icon={STAR_ICON}
      bullets={[
        'Conexión segura con tu ficha de Google Business Profile.',
        'Solicitudes automáticas de reseña por email o WhatsApp tras cada servicio.',
        'Cuadro de mando con rating medio, evolución y respuestas rápidas.',
        'Alertas cuando llega una reseña negativa para responder a tiempo.',
      ]}
    />
  );
}
