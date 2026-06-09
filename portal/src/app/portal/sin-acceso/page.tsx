import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Acceso no disponible',
  description: 'No tienes un portal Kairikos activo. Te explicamos cómo contratarlo.',
  alternates: { canonical: '/portal/sin-acceso' },
  robots: { index: false, follow: false },
};

export default function SinAccesoPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Portal Kairikos</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Aún no tienes acceso al portal</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          El email con el que has iniciado sesión no está asociado a ningún cliente con un chatbot Kairikos
          activo. Si acabas de contratar el servicio, puede que la activación esté en proceso.
        </p>
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <a
            href="https://wa.me/34600000000?text=Hola%2C%20acabo%20de%20contratar%20el%20chatbot%20pero%20no%20tengo%20acceso%20al%20portal"
            className="btn-primary"
          >
            Hablar con el equipo
          </a>
          <Link href="/portal/login" className="btn-ghost">
            Probar con otro email
          </Link>
        </div>
        <p className="mt-6 text-xs text-kairikos-muted">
          ¿Eres nuevo en Kairikos?{' '}
          <a className="underline" href="https://kairikos.com">
            Conoce nuestros servicios
          </a>
          .
        </p>
      </div>
    </div>
  );
}
