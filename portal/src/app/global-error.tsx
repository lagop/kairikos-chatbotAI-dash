'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '720px',
          margin: '0 auto',
          background: '#fafafa',
          color: '#1a1a1a',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Error global</h1>
        <pre
          style={{
            background: '#fee',
            padding: '1rem',
            border: '1px solid #fcc',
            borderRadius: '6px',
            overflow: 'auto',
            fontSize: '0.875rem',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message || '(sin mensaje)'}
          {error.digest ? `\nDigest: ${error.digest}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            marginTop: '1rem',
            background: '#1a1a1a',
            color: '#fff',
            border: 'none',
            padding: '0.625rem 1.25rem',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Reintentar
        </button>
      </body>
    </html>
  );
}