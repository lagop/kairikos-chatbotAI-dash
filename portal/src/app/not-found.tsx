import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card text-center">
        <h1 className="text-2xl font-semibold tracking-tight">No encontrado</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          La página que buscas no existe o ya no está disponible.
        </p>
        <Link href="/portal" className="btn-primary mt-6 inline-flex">
          Volver al portal
        </Link>
      </div>
    </div>
  );
}
