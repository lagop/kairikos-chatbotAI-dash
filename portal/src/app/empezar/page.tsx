import type { Metadata } from 'next';
import Link from 'next/link';

const SITE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
const PAGE_PATH = '/empezar';

export const metadata: Metadata = {
  title: 'Empezar — Crea tu portal Kairikos',
  description:
    'Configura tu producto Kairikos en menos de 5 minutos: alta, selección de plan, configuración mínima y activación sin intervención manual.',
  alternates: { canonical: `${SITE_URL}${PAGE_PATH}` },
  openGraph: {
    title: 'Empezar — Crea tu portal Kairikos',
    description:
      'Alta sin llamadas. Elige producto, configura lo esencial, paga con Stripe y empieza en menos de 5 minutos.',
    siteName: 'Kairikos',
    type: 'website',
    locale: 'es_ES',
    url: `${SITE_URL}${PAGE_PATH}`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Empezar — Crea tu portal Kairikos',
    description:
      'Alta sin llamadas en menos de 5 minutos. Producto, configuración y pago en un único wizard.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

const PILLARS = [
  {
    title: 'Sin intervención manual',
    body: 'Te registras, eliges tu producto, configuras lo esencial y pagas. El owner solo aparece si tú lo pides.',
  },
  {
    title: 'Menos de 5 minutos',
    body: 'Diseñado para llegar de la landing a activo en menos de 5 minutos, con Stripe y Resend en el camino crítico.',
  },
  {
    title: 'Plan cuando lo necesites',
    body: 'Starter, Pro o Premium. Cambias de plan cuando tu negocio lo pida, sin penalización.',
  },
] as const;

const STEPS = [
  { id: 1, label: 'Registro' },
  { id: 2, label: 'Producto' },
  { id: 3, label: 'Configuración' },
  { id: 4, label: 'Pago' },
  { id: 5, label: 'Activación' },
] as const;

export default function EmpezarPage() {
  return (
    <main className="min-h-screen bg-kairikos-bg text-kairikos-text">
      <div className="mx-auto flex max-w-page flex-col gap-12 px-4 py-10 sm:px-6 sm:py-16">
        <header className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight"
            aria-label="Inicio Kairikos"
          >
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-lg bg-kairikos-accent text-sm font-bold"
            >
              K
            </span>
            Kairikos
          </Link>
          <nav aria-label="Acceso rápido" className="flex items-center gap-3 text-sm">
            <Link
              href="/portal/login"
              className="rounded-lg px-3 py-1.5 text-kairikos-muted hover:text-kairikos-text focus:outline-none focus-visible:ring-2 focus-visible:ring-kairikos-accent"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/onboarding/signup"
              className="btn-primary"
              data-testid="empezar-cta"
            >
              Empezar
            </Link>
          </nav>
        </header>

        <section className="grid gap-10">
          <div className="max-w-2xl space-y-5">
            <span className="pill-muted">Self-serve · sin esperar al owner</span>
            <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">
              Activa tu portal Kairikos en menos de 5 minutos.
            </h1>
            <p className="text-base text-kairikos-muted sm:text-lg">
              Pasos cortos, sin formularios eternos. Eliges producto, configuras lo
              esencial, pagas con Stripe y empiezas. Te avisamos por email en cuanto
              tu portal esté activo.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/onboarding/signup"
                className="btn-primary text-base"
                data-testid="empezar-primary-cta"
              >
                Empezar ahora
              </Link>
              <Link
                href="/portal/login"
                className="btn-ghost"
                data-testid="empezar-secondary-cta"
              >
                Ya tengo cuenta
              </Link>
            </div>
          </div>

          <ol
            className="flex flex-wrap gap-2 text-xs"
            aria-label="Resumen de los pasos del wizard"
          >
            {STEPS.map((step) => (
              <li
                key={step.id}
                className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1.5 text-kairikos-muted"
              >
                <span className="mr-1 font-semibold text-kairikos-text">{step.id}.</span>
                {step.label}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="empezar-beneficios" className="grid gap-4 sm:grid-cols-3">
          <h2 id="empezar-beneficios" className="sr-only">
            Por qué empezar con Kairikos
          </h2>
          {PILLARS.map((pillar) => (
            <article key={pillar.title} className="card space-y-2">
              <h3 className="text-base font-semibold">{pillar.title}</h3>
              <p className="text-sm text-kairikos-muted">{pillar.body}</p>
            </article>
          ))}
        </section>

        <footer className="border-t border-kairikos-border pt-6 text-xs text-kairikos-muted">
          <p>
            ¿Dudas durante el alta? Escríbenos a{' '}
            <a
              href="mailto:soporte@kairikos.com"
              className="underline-offset-2 hover:underline"
            >
              soporte@kairikos.com
            </a>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
