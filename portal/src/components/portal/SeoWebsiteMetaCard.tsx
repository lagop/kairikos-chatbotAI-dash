'use client';

import { useState } from 'react';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — «Cómo sale tu web en Google», para
// quien tiene el SEO sobre una web de Kairikos. La IA propone el título y la
// descripción de cada página; el cliente los revisa, los retoca si quiere y
// los aplica con un clic. Nada se guarda al proponer (website-meta-ai.ts).
// =============================================================================

type Page = { ruta: string; titulo: string; metaTitulo: string; metaDescripcion: string };
type Row = Page & { propuestoTitulo: string; propuestaDescripcion: string; incluir: boolean };

const ERRORS: Record<string, string> = {
  ai_not_configured: 'La propuesta automática no está disponible ahora mismo.',
  ai_failed: 'No hemos podido preparar la propuesta. Inténtalo de nuevo en un momento.',
  not_kairikos_website: 'Guarda primero en tu perfil que tu web es la que te hicimos nosotros.',
};

const PUBLISH_ERRORS: Record<string, string> = {
  example_data_pending: 'quedan datos de ejemplo por confirmar en el editor de tu web',
  legal_data_missing: 'faltan tus datos legales en el editor de tu web',
};

export function SeoWebsiteMetaCard({ clientProductId }: { clientProductId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<'propose' | 'apply' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function propose() {
    setBusy('propose');
    setError(null);
    setMessage(null);
    const res = await fetch('/api/portal/seo/website-meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientProductId }),
    }).catch(() => null);
    setBusy(null);
    const data = (await res?.json().catch(() => null)) as { error?: string; paginas?: Page[]; propuestas?: { ruta: string; metaTitulo: string; metaDescripcion: string }[] } | null;
    if (!res?.ok || !data?.paginas) {
      setError(ERRORS[data?.error ?? ''] ?? 'No se pudo preparar la propuesta.');
      return;
    }
    setRows(
      data.paginas.map((p) => {
        const prop = data.propuestas?.find((x) => x.ruta === p.ruta);
        return { ...p, propuestoTitulo: prop?.metaTitulo ?? p.metaTitulo, propuestaDescripcion: prop?.metaDescripcion ?? p.metaDescripcion, incluir: Boolean(prop) };
      }),
    );
  }

  async function apply() {
    if (!rows) return;
    const paginas = rows.filter((r) => r.incluir).map((r) => ({ ruta: r.ruta, metaTitulo: r.propuestoTitulo, metaDescripcion: r.propuestaDescripcion }));
    if (!paginas.length) return;
    setBusy('apply');
    setError(null);
    const res = await fetch('/api/portal/seo/website-meta/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientProductId, paginas }),
    }).catch(() => null);
    setBusy(null);
    const data = (await res?.json().catch(() => null)) as { publicada?: boolean; errorPublicacion?: string | null; error?: string } | null;
    if (!res?.ok || !data) {
      setError('No se pudieron guardar. Tu web no ha cambiado.');
      return;
    }
    setRows(null);
    setMessage(
      data.publicada
        ? 'Aplicados y publicados: Google los verá la próxima vez que pase por tu web.'
        : `Guardados en tu web, pero no se ha podido publicar todavía: ${PUBLISH_ERRORS[data.errorPublicacion ?? ''] ?? 'lo estamos mirando'}. Saldrán en cuanto la publiques.`,
    );
  }

  const update = (i: number, patch: Partial<Row>) => setRows((prev) => prev && prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className="card space-y-3" data-testid="seo-website-meta">
      <p className="font-semibold">Cómo sale tu web en Google</p>
      <p className="text-sm text-kairikos-muted">
        Cada página de tu web tiene un título y una descripción que Google enseña en sus resultados. Te proponemos unos pensados para tus búsquedas; los revisas y los aplicas con un clic.
      </p>
      {!rows ? (
        <button type="button" className="btn-primary" onClick={propose} disabled={busy !== null}>
          {busy === 'propose' ? 'Preparando la propuesta…' : 'Proponer títulos y descripciones'}
        </button>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={r.ruta || 'inicio'} className="rounded-lg border border-kairikos-border p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={r.incluir} onChange={(e) => update(i, { incluir: e.target.checked })} />
                {r.titulo} <span className="text-xs text-kairikos-muted">/{r.ruta ? `${r.ruta}/` : ''}</span>
              </label>
              {r.metaTitulo || r.metaDescripcion ? (
                <p className="text-xs text-kairikos-muted">
                  Ahora: {r.metaTitulo || '(sin título)'} — {r.metaDescripcion || '(sin descripción)'}
                </p>
              ) : null}
              <label className="block text-sm">
                Título ({r.propuestoTitulo.length}/60)
                <input className="input mt-1 w-full" maxLength={70} value={r.propuestoTitulo} onChange={(e) => update(i, { propuestoTitulo: e.target.value, incluir: true })} />
              </label>
              <label className="block text-sm">
                Descripción ({r.propuestaDescripcion.length}/155)
                <textarea className="input mt-1 w-full" rows={2} maxLength={160} value={r.propuestaDescripcion} onChange={(e) => update(i, { propuestaDescripcion: e.target.value, incluir: true })} />
              </label>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={apply} disabled={busy !== null || !rows.some((r) => r.incluir)}>
              {busy === 'apply' ? 'Aplicando…' : 'Aplicar a mi web'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setRows(null)} disabled={busy !== null}>
              Descartar
            </button>
          </div>
        </div>
      )}
      {message ? <p className="text-sm text-kairikos-success">{message}</p> : null}
      {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}
    </section>
  );
}
