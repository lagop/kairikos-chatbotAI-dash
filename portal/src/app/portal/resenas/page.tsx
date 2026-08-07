import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Reseñas · No disponible en tu plan',
  description:
    'La gestión de reseñas de Google no está incluida en tu plan actual de Kairikos. Te contamos qué opciones tienes para habilitarla.',
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
    <path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9 6-.9L12 3.5z" />
  </svg>
);

export default function PortalResenasPage() {
  return (
    <div
      className="space-y-6"
      data-testid="portal-resenas-unavailable"
    >
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">
          Reseñas
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Las reseñas de Google no están incluidas en tu plan actual
        </h1>
        <p className="max-w-2xl text-sm text-kairikos-muted">
          Esta sección del portal no está activa para tu cuenta. No verás datos
          de reseñas aquí hasta que la gestión de reseñas forme parte del plan
          que tengas contratado.
        </p>
      </header>

      <section
        className="card flex flex-col items-center gap-5 py-12 text-center"
        aria-label="Reseñas de Google no disponibles en este plan"
      >
        <span
          aria-hidden
          className="grid h-16 w-16 place-items-center rounded-2xl border border-kairikos-border bg-kairikos-surface2 text-kairikos-muted"
        >
          {STAR_ICON}
        </span>
        <div className="space-y-2">
          <p className="text-base font-semibold">Función no disponible</p>
          <p className="mx-auto max-w-md text-sm text-kairikos-muted">
            Si quieres usar la gestión de reseñas de Google con Kairikos,
            escríbenos y te contamos las opciones para añadirla a tu cuenta.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/portal/support"
            className="btn-primary"
            data-testid="resenas-contact-support"
          >
            Hablar con soporte
          </Link>
          <Link
            href="/portal"
            className="btn-ghost"
            data-testid="resenas-back-to-dashboard"
          >
            Volver al inicio
          </Link>
        </div>
      </section>
    </div>
  );
}