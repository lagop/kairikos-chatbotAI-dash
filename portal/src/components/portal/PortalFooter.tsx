import Link from 'next/link';

export function PortalFooter() {
  return (
    <footer className="border-t border-kairikos-border bg-kairikos-bg">
      <div className="mx-auto flex max-w-page flex-col gap-2 px-4 py-6 text-sm text-kairikos-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>© {new Date().getFullYear()} Kairikos · Portal de cliente</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          <li>
            <Link href="/portal/support" className="hover:text-kairikos-text">
              Soporte
            </Link>
          </li>
          <li>
            <a
              href="https://kairikos.com/privacidad"
              target="_blank"
              rel="noreferrer"
              className="hover:text-kairikos-text"
            >
              Privacidad
            </a>
          </li>
          <li>
            <a
              href="https://kairikos.com/terminos"
              target="_blank"
              rel="noreferrer"
              className="hover:text-kairikos-text"
            >
              Términos
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
