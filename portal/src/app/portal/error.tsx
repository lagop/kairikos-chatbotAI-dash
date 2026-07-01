'use client';

import { useEffect } from 'react';

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function PortalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[portal] runtime error captured by boundary:', error);
  }, [error]);

  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Error del portal</title>
      </head>
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '2rem',
          maxWidth: '720px',
          margin: '0 auto',
          color: '#1a1a1a',
          background: '#fafafa',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>
          El portal ha encontrado un error
        </h1>
        <p style={{ marginBottom: '1.5rem', color: '#555' }}>
          Se ha producido un error inesperado al renderizar esta página. El
          equipo técnico ha sido notificado automáticamente.
        </p>

        <div
          style={{
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '6px',
            padding: '1rem',
            marginBottom: '1.5rem',
            fontSize: '0.875rem',
          }}
        >
          <div style={{ marginBottom: '0.5rem' }}>
            <strong>Mensaje:</strong>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: '0.25rem 0 0',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                color: '#b91c1c',
              }}
            >
              {error.message || '(sin mensaje)'}
            </pre>
          </div>
          {error.digest ? (
            <div>
              <strong>Digest:</strong>{' '}
              <code
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  color: '#666',
                }}
              >
                {error.digest}
              </code>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => reset()}
          style={{
            background: '#1a1a1a',
            color: '#fff',
            border: 'none',
            padding: '0.625rem 1.25rem',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          Reintentar
        </button>
      </body>
    </html>
  );
}