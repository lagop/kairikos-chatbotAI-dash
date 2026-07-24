import type { Metadata } from 'next';
import { PortalPlaceholderPage } from '@/components/portal/PortalPlaceholderPage';

export const metadata: Metadata = {
  title: 'Facturación · Próximamente',
  description:
    'La nueva sección de Facturación del portal Kairikos está en preparación. Llegará con la Fase 3 del Dashboard v2.',
  alternates: { canonical: '/portal/facturacion' },
  robots: { index: false, follow: false },
};

const BILLING_ICON = (
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
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="M3 10h18" />
    <path d="M7 15h4" />
  </svg>
);

export default function PortalFacturacionPage() {
  return (
    <PortalPlaceholderPage
      eyebrow="Facturación"
      title="Tu plan y facturas en un solo lugar"
      description="Pronto podrás consultar tu plan contratado, la cuota mensual, el histórico de facturas y descargar cada recibo en PDF desde aquí."
      phase="3 del Dashboard v2"
      icon={BILLING_ICON}
      bullets={[
        'Resumen del plan activo, próxima fecha de cobro y método de pago.',
        'Historial de facturas descargable en PDF firmado por Stripe.',
        'Cambio de plan o método de pago desde el propio portal, sin emails.',
        'Notificaciones automáticas cuando se emita una nueva factura.',
      ]}
    />
  );
}
