'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Fase 3 — la base de conocimiento del chatbot, en la pantalla del cliente.
//
// Mismo patrón que SeoKeywordsCard/ProspectingProfileCard: entradas
// controladas, fetch a su ruta, router.refresh() al terminar.
//
// Dos formas de añadir material porque son dos gestos distintos: pegar un
// texto que ya tienes escrito, y señalar una página de tu web. La segunda
// no se resuelve al instante — se dice, en vez de dejar una fila en
// "pendiente" sin explicación.
// =============================================================================

export interface KnowledgeDocumentRow {
  id: string;
  source: string;
  title: string;
  sourceUrl: string | null;
  status: string;
  error: string | null;
  charCount: number;
  chunks: number;
  crawledAt: string | null;
  createdAt: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa lo que has escrito: hace falta un título y al menos unas líneas de texto.',
  invalid_url: 'Esa dirección no parece una página web pública. Compruébala y vuelve a intentarlo.',
  document_limit_reached: 'Has llegado al máximo de documentos. Borra alguno para añadir otro.',
  forbidden: 'Tu cuenta no tiene el chatbot contratado.',
  not_found: 'Ese documento ya no está.',
  save_failed: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
  delete_failed: 'Algo falló al borrar. Si persiste, contacta con el equipo técnico.',
};

/** Los motivos de fallo del rastreo, dichos en el idioma del cliente. El
 *  código en crudo ('http_404') no le dice nada a quien tiene que decidir
 *  si corrige la URL o si su web necesita otra cosa. */
function crawlErrorLabel(error: string | null): string {
  if (!error) return 'No pudimos leer esta página.';
  if (error === 'no_readable_text') {
    return 'Esta página no tiene texto que podamos leer: seguramente se dibuja con JavaScript. Prueba a pegar el contenido a mano.';
  }
  if (error === 'timeout') return 'La página tardó demasiado en responder.';
  if (error === 'url_not_allowed') return 'Esa dirección no es una web pública.';
  if (error.startsWith('http_404')) return 'Esa página no existe (error 404).';
  if (error.startsWith('http_403')) return 'La web nos bloqueó el acceso.';
  if (error.startsWith('http_')) return `La web respondió con un error (${error.replace('http_', '')}).`;
  if (error.startsWith('unsupported_content_type')) return 'Ese enlace no es una página web, es un archivo.';
  return 'No pudimos leer esta página.';
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

function StatusPill({ doc }: { doc: KnowledgeDocumentRow }) {
  if (doc.status === 'pending') {
    return <span className="pill-muted">Leyendo tu web…</span>;
  }
  if (doc.status === 'failed') {
    return <span className="pill-warning">No se pudo leer</span>;
  }
  return <span className="pill-success">Activo</span>;
}

export function ChatbotKnowledgeCard({
  documents,
  limit,
}: {
  documents: KnowledgeDocumentRow[];
  limit: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'manual' | 'web'>('manual');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = documents.length >= limit;

  async function add() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const body =
        mode === 'manual'
          ? { source: 'manual', title: title.trim(), content: content.trim() }
          : { source: 'web', url: url.trim() };

      const res = await fetch('/api/portal/chatbot/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; status?: string } | null;

      if (!res.ok) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? ERROR_LABEL.save_failed);
        return;
      }

      setTitle('');
      setContent('');
      setUrl('');
      setNotice(
        json?.status === 'pending'
          ? 'Añadida. La leeremos en unos minutos y aparecerá aquí como activa.'
          : 'Guardado. Tu bot ya puede usarlo.',
      );
      router.refresh();
    } catch {
      setError(ERROR_LABEL.save_failed);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/chatbot/knowledge', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(ERROR_LABEL[json?.error ?? ''] ?? ERROR_LABEL.delete_failed);
        return;
      }
      router.refresh();
    } catch {
      setError(ERROR_LABEL.delete_failed);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy && !atLimit && (mode === 'manual' ? title.trim().length >= 2 && content.trim().length >= 20 : url.trim().length >= 4);

  return (
    <section className="card space-y-5" aria-label="Base de conocimiento" data-testid="knowledge-card">
      <div>
        <p className="text-sm font-semibold">Lo que tu bot sabe de ti</p>
        <p className="text-xs text-kairikos-muted">
          Además de las preguntas frecuentes del onboarding, puedes darle documentos tuyos o páginas de tu web. El bot
          los usará para responder, y seguirá sin inventarse nada que no esté aquí.
        </p>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Cómo añadir material">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          onClick={() => setMode('manual')}
          className={mode === 'manual' ? 'btn btn-primary' : 'btn border border-kairikos-border'}
        >
          Escribir o pegar texto
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'web'}
          onClick={() => setMode('web')}
          className={mode === 'web' ? 'btn btn-primary' : 'btn border border-kairikos-border'}
        >
          Leer una página de mi web
        </button>
      </div>

      {mode === 'manual' ? (
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-kairikos-muted">De qué trata</span>
            <input
              className="input mt-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Política de cancelaciones"
              maxLength={120}
              data-testid="knowledge-title"
            />
          </label>
          <label className="block">
            <span className="text-sm text-kairikos-muted">El texto</span>
            <textarea
              className="input mt-1 min-h-[9rem]"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Pega aquí lo que quieras que sepa: condiciones, precios que sí publicas, cómo llegar, qué incluye cada servicio…"
              data-testid="knowledge-content"
            />
          </label>
        </div>
      ) : (
        <label className="block">
          <span className="text-sm text-kairikos-muted">Dirección de la página</span>
          <input
            className="input mt-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="peluqueriaaurora.es/servicios"
            data-testid="knowledge-url"
          />
          <span className="mt-1 block text-xs text-kairikos-muted">
            Leemos esa página, no el sitio entero. Añade una por cada página que quieras que conozca.
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={add} disabled={!canSubmit} data-testid="knowledge-add">
          {busy ? 'Guardando…' : 'Añadir'}
        </button>
        <span className="text-xs text-kairikos-muted">
          {documents.length} de {limit} documentos
        </span>
        {error ? (
          <span className="text-sm text-kairikos-danger" role="alert">
            {error}
          </span>
        ) : null}
        {notice ? <span className="text-sm text-kairikos-success">{notice}</span> : null}
      </div>

      {atLimit ? (
        <p className="text-xs text-kairikos-muted">
          Has llegado al máximo. Borra algún documento si quieres añadir otro.
        </p>
      ) : null}

      {documents.length === 0 ? (
        <p className="text-sm text-kairikos-muted">
          Todavía no has añadido nada. De momento tu bot responde solo con las preguntas frecuentes del onboarding.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="knowledge-list">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
              data-testid="knowledge-doc"
              data-status={doc.status}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill doc={doc} />
                  <p className="truncate text-sm font-medium text-kairikos-text">{doc.title}</p>
                </div>
                <p className="mt-1 text-xs text-kairikos-muted">
                  {doc.source === 'web' ? 'De tu web' : 'Texto tuyo'}
                  {doc.status === 'ready'
                    ? ` · ${doc.chunks} ${doc.chunks === 1 ? 'fragmento' : 'fragmentos'} · añadido el ${DATE_FMT.format(new Date(doc.createdAt))}`
                    : ''}
                </p>
                {doc.status === 'failed' ? (
                  <p className="mt-1 text-xs text-kairikos-warning" data-testid="knowledge-doc-error">
                    {crawlErrorLabel(doc.error)}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="btn border border-kairikos-border text-sm"
                onClick={() => remove(doc.id)}
                disabled={busy}
                aria-label={`Borrar ${doc.title}`}
              >
                Borrar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
