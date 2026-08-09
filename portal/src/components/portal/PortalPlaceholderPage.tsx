import type { ReactNode } from 'react';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';

export function PortalPlaceholderPage({
  eyebrow,
  title,
  description,
  phase,
  icon,
  bullets,
}: {
  eyebrow: string;
  title: string;
  description: string;
  phase: string;
  icon: ReactNode;
  bullets: string[];
}) {
  return (
    <div className="space-y-6" data-testid="portal-placeholder-page">
      <PageHeading eyebrow={eyebrow} title={title} description={description} />
      <section
        className="card flex flex-col items-center gap-5 py-12 text-center"
        aria-label={`${title} · próximamente`}
      >
        <span
          aria-hidden
          className="grid h-16 w-16 place-items-center rounded-2xl border border-kairikos-border bg-kairikos-surface2 text-kairikos-accent2"
        >
          {icon}
        </span>
        <div className="space-y-2">
          <p className="text-base font-semibold">Próximamente</p>
          <p className="mx-auto max-w-md text-sm text-kairikos-muted">
            Esta sección forma parte del Dashboard v2 de Kairikos. La estamos
            preparando en la fase{' '}
            <span className="font-semibold text-kairikos-text">{phase}</span> y
            estará disponible muy pronto.
          </p>
        </div>
        <Link href="/portal" className="btn-ghost" data-testid="placeholder-back-to-dashboard">
          Volver al inicio
        </Link>
      </section>
      <section className="card" aria-label="Qué encontrarás en esta sección">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-kairikos-muted">
          Qué encontrarás aquí
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-kairikos-text">
          {bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-kairikos-accent2"
              />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
