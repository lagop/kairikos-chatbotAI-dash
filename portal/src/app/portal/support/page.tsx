import type { Metadata } from 'next';
import { PageHeading } from '@/components/portal/PageHeading';
import { getSupportLink } from '@/lib/portal-data';
import { requirePortalSession } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Soporte',
  description: 'Canales de soporte para clientes del portal Kairikos.',
  alternates: { canonical: '/portal/support' },
  robots: { index: false, follow: false },
};

export default async function SupportPage() {
  const session = await requirePortalSession();
  const support = await getSupportLink(session.accessToken ?? '');

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Soporte"
        title="Estamos para ayudarte"
        description="Elige el canal que prefieras. Te respondemos rápido en horario laboral (L–V, 9:00–18:00 CET)."
      />

      <section
        className="card"
        aria-label="Canales de soporte"
        data-testid="support-links"
      >
        <p className="text-sm text-kairikos-muted">{support.description}</p>
        <a
          href={support.href}
          target="_blank"
          rel="noreferrer noopener"
          className="btn-primary mt-4 w-full sm:w-auto"
        >
          {support.label}
        </a>
      </section>

      <section className="card" aria-label="Contacto alternativo">
        <h2 className="text-base font-semibold">¿Prefieres email?</h2>
        <p className="mt-2 text-sm text-kairikos-muted">
          Escríbenos a{' '}
          <a className="text-kairikos-accent2 hover:underline" href="mailto:hola@kairikos.com">
            hola@kairikos.com
          </a>{' '}
          y te respondemos en menos de 24 h laborables.
        </p>
      </section>
    </div>
  );
}
