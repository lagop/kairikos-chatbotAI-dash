import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/portal/ThemeToggle';
import { CalculadoraForm, type SectorOption } from '@/components/public/CalculadoraForm';
import { PUBLIC_SECTORS } from '@/lib/public-draft-request';

// =============================================================================
// /calculadora (A5) — pública, sin sesión. Igual que /empezar y /mi-web, cae
// fuera del matcher de src/middleware.ts ('/portal/:path*',
// '/admin/portal/:path*'), así que no hay que eximirla de nada.
//
// La ruta POST /api/public/calculadora ya existía y sirve CORS abierto para
// poder incrustar esto en kairikos.com. Esta página es lo que hace que A5
// se pueda usar HOY, sin tocar el WordPress: un enlace que se manda por
// WhatsApp, se pone en una firma de correo o se comparte en un grupo de
// gremio. El día que la calculadora viva también dentro de kairikos.com,
// las dos llamarán a la misma ruta y darán el mismo número.
//
// Los sectores salen de PUBLIC_SECTORS, la misma lista que valida el
// servidor: si aquí apareciera uno que allí no existe, caería en 'otro' sin
// avisar y el visitante vería el encargo medio de un fontanero.
// =============================================================================

const TITLE = '¿Cuánto te cuestan las llamadas que no contestas?';
const DESCRIPTION =
  'Calcula en diez segundos lo que se te va al año por las llamadas que entran mientras trabajas.';

export const metadata: Metadata = {
  title: `${TITLE} — Kairikos`,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', locale: 'es_ES', siteName: 'Kairikos' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
  alternates: { canonical: '/calculadora' },
};

export const dynamic = 'force-dynamic';

export default function CalculadoraPage() {
  // 'otro' al final: es la salida de emergencia, no una opción que compita
  // con las de arriba.
  const sectores: SectorOption[] = Object.entries(PUBLIC_SECTORS)
    .filter(([value]) => value !== 'otro')
    .map(([value, meta]) => ({ value, label: meta.label }));
  sectores.push({ value: 'otro', label: PUBLIC_SECTORS.otro.label });

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-4 flex justify-end">
        <ThemeToggle />
      </div>

      <div className="mb-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Kairikos</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{TITLE}</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          Tres preguntas y el número. No hace falta dejar ningún dato para verlo.
        </p>
      </div>

      <CalculadoraForm sectores={sectores} />

      <p className="mt-8 text-center text-xs text-kairikos-muted">
        ¿Quieres dejar de perderlas?{' '}
        <a className="underline" href="/empezar">
          Mira los productos
        </a>
      </p>
    </div>
  );
}
