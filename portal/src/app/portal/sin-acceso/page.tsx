import type { Metadata } from 'next';
import Link from 'next/link';
import { supportWhatsappUrl } from '@/lib/portal-data';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Acceso no disponible',
  description: 'No tienes un portal Kairikos activo. Te explicamos cómo contratarlo.',
  alternates: { canonical: '/portal/sin-acceso' },
  robots: { index: false, follow: false },
};

// =============================================================================
// 24/10/2026 — la sesión de operador también trae aquí.
//
// Con las dos sesiones en el mismo navegador manda la de operador (ver
// getSession en lib/session.ts), y esa no tiene acceso a las páginas de
// cliente: el operador que entraba como cliente para rellenar la configuración
// del chatbot de Kairikos acababa aquí, leyendo que su email «no está asociado
// a ningún cliente» — falso, y sin pista de qué hacer. Ahora, si hay sesión de
// operador, se dice eso y cómo salir. Cerrar la sesión de operador
// (/admin/logout) cierra también la de cliente, por eso la ventana privada va
// primero.
//
// Y el texto general ya no habla solo del chatbot: el portal tiene siete
// productos desde hace semanas.
// =============================================================================
export default async function SinAccesoPage() {
  const session = await getSession().catch(() => null);

  if (session?.isOperator) {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10 sm:px-6">
        <div className="card text-center" data-testid="sin-acceso-operador">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Portal Kairikos</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Tienes abierta la sesión de operador</h1>
          <p className="mt-3 text-sm text-kairikos-muted">
            En este navegador está abierta la sesión de operador ({session.email}), y mientras lo esté manda sobre la de
            cliente. Para entrar como un cliente, abre una ventana privada e inicia sesión ahí con su email: así tienes
            el admin en esta ventana y el portal del cliente en la otra.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Link href="/admin/portal" className="btn-primary">
              Volver al admin
            </Link>
            <form method="post" action="/admin/logout">
              <button type="submit" className="btn-ghost">
                Cerrar la sesión de operador
              </button>
            </form>
          </div>
          <p className="mt-6 text-xs text-kairikos-muted">
            Cerrar la sesión de operador cierra también la de cliente: después tendrás que volver a entrar con su email.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card text-center" data-testid="sin-acceso-cliente">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Portal Kairikos</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Aún no tienes acceso al portal</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          El email con el que has iniciado sesión no está asociado a ningún cliente con un producto Kairikos activo. Si
          acabas de contratar un servicio, puede que la activación esté en proceso.
        </p>
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <a
            href={supportWhatsappUrl('Hola, acabo de contratar un servicio de Kairikos pero no tengo acceso al portal')}
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
