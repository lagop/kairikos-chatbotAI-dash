'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Notice, call, dateTimeText, errorMessage, type NoticeMessage } from './cartera-ui';

// =============================================================================
// Cartera — la pestaña Contactos (PR 5): lo que llega de los formularios de la
// web. Tipo, casas, nombre, contacto, idioma, fecha y estado; «Atendido» lo
// marca (y se puede deshacer). Sin borrar: se borran solos a los 24 meses.
//
// Los tipos llegan de la web tal cual (`visit`, `saved_email`…) y se enseñan
// en español con las etiquetas de lib/cartera/enquiry-rules.ts, que la página
// pasa ya resueltas: un componente de cliente no importa un lib del servidor.
// =============================================================================

export interface CarteraEnquiryRow {
  id: string;
  kind: string;
  refs: Array<{ ref: string; homeId: string | null; title: string | null }>;
  name: string | null;
  contact: string;
  lang: string;
  summary: string;
  status: string;
  createdAt: string;
  consentAt: string;
  copiedToLeads: boolean;
}

const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'Inglés', de: 'Alemán' };

export function CarteraEnquiries({ rows: initial, kindLabels, readOnly }: { rows: CarteraEnquiryRow[]; kindLabels: Record<string, string>; readOnly: boolean }) {
  const [rows, setRows] = useState(initial);
  const [filter, setFilter] = useState<'nuevo' | 'todos'>('todos');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<NoticeMessage>(null);

  const shown = rows.filter((r) => filter === 'todos' || r.status === filter);
  const pending = rows.filter((r) => r.status === 'nuevo').length;

  async function mark(row: CarteraEnquiryRow, status: 'nuevo' | 'atendido') {
    setBusy(row.id);
    setMessage(null);
    try {
      const { ok, data } = await call('PATCH', '/api/portal/cartera/contactos', { id: row.id, status });
      if (!ok) {
        setMessage({ tone: 'error', text: errorMessage(data) });
        return;
      }
      setRows((list) => list.map((r) => (r.id === row.id ? { ...r, status } : r)));
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-2xl flex-1 text-sm text-kairikos-muted">
          Lo que te escriben desde los formularios de tu web: visitas, valoraciones, propietarios, fuera de mercado, el informe y las casas guardadas. Cada uno te llega también por correo. Se guardan 24 meses.
        </p>
        <label className="text-sm">
          <span className="sr-only">Mostrar</span>
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as 'nuevo' | 'todos')} data-testid="cartera-enquiries-filter">
            <option value="todos">Todos</option>
            <option value="nuevo">Sin atender ({pending})</option>
          </select>
        </label>
      </div>
      <Notice message={message} />

      {rows.length === 0 ? (
        <p className="card text-sm text-kairikos-muted">Todavía no ha llegado ningún contacto desde tu web.</p>
      ) : shown.length === 0 ? (
        <p className="card text-sm text-kairikos-muted">Todos atendidos.</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm" data-testid="cartera-enquiries">
            <thead className="text-xs text-kairikos-muted">
              <tr className="border-b border-kairikos-border">
                <th className="px-4 py-2 font-normal">Tipo</th>
                <th className="px-2 py-2 font-normal">Casas</th>
                <th className="px-2 py-2 font-normal">Nombre</th>
                <th className="px-2 py-2 font-normal">Contacto</th>
                <th className="px-2 py-2 font-normal">Idioma</th>
                <th className="px-2 py-2 font-normal">Fecha</th>
                <th className="px-4 py-2 font-normal">Estado</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-kairikos-border align-top last:border-0" data-testid="cartera-enquiry">
                  <td className="px-4 py-2">
                    <span className="font-medium">{kindLabels[r.kind] ?? r.kind}</span>
                    {r.summary ? <span className="block max-w-xs text-xs text-kairikos-muted">{r.summary}</span> : null}
                    {r.copiedToLeads ? <span className="mt-1 inline-block text-xs text-kairikos-muted">Copiado a Leads</span> : null}
                  </td>
                  <td className="px-2 py-2">
                    {r.refs.length === 0 ? (
                      <span className="text-kairikos-muted">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {r.refs.map((h) => (
                          <li key={h.ref} className="whitespace-nowrap">
                            {h.homeId ? (
                              <Link href={`/portal/cartera/${h.homeId}`} className="font-mono hover:underline" title={h.title ?? undefined}>
                                {h.ref}
                              </Link>
                            ) : (
                              <span className="font-mono text-kairikos-muted">{h.ref}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-2 py-2">{r.name ?? <span className="text-kairikos-muted">—</span>}</td>
                  <td className="px-2 py-2">
                    {r.contact.includes('@') ? (
                      <a href={`mailto:${r.contact}`} className="break-all hover:underline">
                        {r.contact}
                      </a>
                    ) : (
                      <a href={`tel:${r.contact.replace(/[^0-9+]/g, '')}`} className="whitespace-nowrap hover:underline">
                        {r.contact}
                      </a>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">{LANG_LABELS[r.lang] ?? r.lang}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-kairikos-muted" title={`Consentimiento: ${dateTimeText(r.consentAt)}`}>
                    {dateTimeText(r.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {r.status === 'atendido' ? <span className="pill-muted">Atendido</span> : <span className="pill-warning">Nuevo</span>}
                    {!readOnly ? (
                      <button
                        type="button"
                        className="btn-ghost ml-2 text-xs"
                        disabled={busy === r.id}
                        onClick={() => mark(r, r.status === 'atendido' ? 'nuevo' : 'atendido')}
                        data-testid="cartera-enquiry-toggle"
                      >
                        {r.status === 'atendido' ? 'Deshacer' : 'Marcar atendido'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
