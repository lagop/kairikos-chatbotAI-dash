'use client';

import { useState } from 'react';

// =============================================================================
// 31/10/2026 — «Versiones anteriores» debajo del editor de un borrador (de un
// prospecto o pedido en kairikos.com). Las pide al abrirse, no al pintar la
// página: así lo que se acaba de guardar en el editor ya sale en la lista.
// Volver a una recarga la página entera, porque el editor tiene en memoria el
// contenido y la huella de antes (lib/draft-versions.ts).
// =============================================================================

interface Row {
  id: string;
  accion: string;
  nota: string | null;
  autor: string | null;
  createdAt: string;
  conPlantilla: boolean;
}

const ACCION: Record<string, string> = {
  editado: 'Guardado desde el editor',
  restaurado: 'Se volvió a otra versión',
  regenerado: 'Se regeneró',
  retoque: 'Retoque con Claude Code',
  convertido: 'Pasado al diseño nuevo',
};

const FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function DraftVersionsPanel({ apiBase }: { apiBase: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/versiones`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setRows(((await res.json()) as { versiones: Row[] }).versiones);
    } catch {
      setError('No se pudieron cargar las versiones.');
    }
  }

  async function volver(row: Row) {
    const aviso = row.conPlantilla
      ? '¿Volver a esta versión? Lo de ahora se guarda en el historial y se puede recuperar. Si tienes cambios sin guardar en el editor, se pierden.'
      : '¿Volver a esta versión? Es del diseño antiguo, sin plantilla: después no se podrá editar aquí. Lo de ahora se guarda y se puede recuperar.';
    if (!window.confirm(aviso)) return;
    setBusy(row.id);
    try {
      const res = await fetch(`${apiBase}/versiones/${row.id}`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      window.location.reload();
    } catch {
      setBusy(null);
      setError('No se pudo volver a esa versión.');
    }
  }

  return (
    <details
      className="card text-sm"
      data-testid="draft-versions"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer font-medium">Versiones anteriores</summary>
      <p className="mt-2 text-xs text-kairikos-muted">
        Cada vez que se guarda, lo que había queda aquí. Volver a una también guarda lo de ahora, así que se puede deshacer.
      </p>
      {error ? <p className="mt-2 text-kairikos-danger">{error}</p> : null}
      {rows === null && !error ? <p className="mt-2 text-kairikos-muted">Cargando…</p> : null}
      {rows?.length === 0 ? <p className="mt-2 text-kairikos-muted">Todavía no hay ninguna: se crean al guardar.</p> : null}
      {rows?.length ? (
        <ul className="mt-3 space-y-2" data-testid="draft-versions-list">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2">
              <span>
                {FMT.format(new Date(row.createdAt))} · sustituida por: {ACCION[row.accion] ?? row.accion}
                {row.autor ? ` · ${row.autor}` : ''}
                {row.nota && row.accion !== 'restaurado' ? ` · ${row.nota}` : ''}
                {row.conPlantilla ? '' : ' · diseño antiguo'}
              </span>
              <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void volver(row)}>
                {busy === row.id ? 'Volviendo…' : 'Volver a esta'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
