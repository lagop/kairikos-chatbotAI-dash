"use client";

import { useEffect } from "react";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[portal/error.tsx] runtime error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card">
        <header className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Portal Kairikos
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Error en el portal
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            El portal ha fallado al cargar. El detalle del error se muestra
            abajo para que el equipo de soporte pueda diagnosticarlo.
          </p>
        </header>

        <pre
          className="max-h-64 overflow-auto rounded-lg border border-kairikos-border bg-kairikos-surface p-3 text-xs leading-relaxed text-kairikos-text"
          data-testid="portal-error-message"
        >
          {error.message || "Error desconocido"}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="btn-primary inline-flex"
            data-testid="portal-error-retry"
          >
            Reintentar
          </button>
          <a href="/portal/login" className="btn-ghost inline-flex">
            Ir al inicio de sesión
          </a>
        </div>
      </div>
    </div>
  );
}