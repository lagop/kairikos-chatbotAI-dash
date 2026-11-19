'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice, ReadOnlyBanner, call, dateTimeText, errorMessage, priceText, type NoticeMessage } from './cartera-ui';

// =============================================================================
// Cartera — el panel de la agencia, pestaña «Casas» (PR 2). Los datos llegan
// preparados de /portal/cartera/page.tsx; «Nueva casa» crea el borrador por
// POST /api/portal/cartera/casas y abre su ficha (/portal/cartera/<id>).
//
// Solo la pestaña Casas: Contactos, Publicación y Exportar llegan con sus PR
// (3, 4 y 6). La barra de pestañas va ya, con una, para que el panel no
// cambie de forma cuando lleguen.
// =============================================================================

export interface CarteraPanelRow {
  id: string;
  ref: string;
  operation: string;
  status: string;
  price: number | null;
  title: string | null;
  errors: Array<{ path: string; message: string }>;
  updatedAt: string;
  published: boolean;
  photoCount: number;
}

export interface CarteraPanelData {
  readOnly: boolean;
  graceEndsAt: string | null;
  pendingSince: string | null;
  statusLabels: Record<string, string>;
  statuses: { venta: readonly string[]; alquiler: readonly string[] };
  homes: CarteraPanelRow[];
}

const OPERATION_LABELS: Record<string, string> = { venta: 'Venta', alquiler: 'Alquiler' };

function statusPill(status: string, hasErrors: boolean): string {
  if (status === 'borrador') return 'pill-muted';
  if (hasErrors) return 'pill-warning';
  if (status === 'vendida' || status === 'alquilada') return 'pill-muted';
  return 'pill-success';
}

export function CarteraPanel({ data }: { data: CarteraPanelData }) {
  const router = useRouter();
  const [operation, setOperation] = useState<'todas' | 'venta' | 'alquiler'>('todas');
  const [status, setStatus] = useState('todos');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage>(null);

  // Los estados del filtro: los de la operación elegida, o los de las dos.
  const statusOptions = useMemo(() => {
    const list = operation === 'todas' ? [...data.statuses.venta, ...data.statuses.alquiler] : [...data.statuses[operation]];
    return Array.from(new Set(list));
  }, [operation, data.statuses]);

  const homes = data.homes.filter((h) => (operation === 'todas' || h.operation === operation) && (status === 'todos' || h.status === status));

  async function create(op: 'venta' | 'alquiler') {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data: body } = await call('POST', '/api/portal/cartera/casas', { operation: op });
      if (!ok || typeof body.id !== 'string') {
        setMessage({ tone: 'error', text: errorMessage(body) });
        return;
      }
      router.push(`/portal/cartera/${body.id}`);
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {data.readOnly ? <ReadOnlyBanner graceEndsAt={data.graceEndsAt} /> : null}

      <div role="tablist" aria-label="Secciones de la cartera" className="mt-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-kairikos-border">
        <button
          type="button"
          role="tab"
          id="cartera-tab-casas"
          aria-selected
          aria-controls="cartera-panel-casas"
          className="inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-kairikos-accent px-3 py-2.5 text-sm font-semibold text-kairikos-text"
        >
          Casas
          <span className="pill-muted">{data.homes.length}</span>
        </button>
      </div>

      <div role="tabpanel" id="cartera-panel-casas" aria-labelledby="cartera-tab-casas" className="mt-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-3">
            <label className="block text-sm">
              <span className="label">Operación</span>
              <select
                className="input"
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value as typeof operation);
                  setStatus('todos');
                }}
                data-testid="cartera-filter-operation"
              >
                <option value="todas">Todas</option>
                <option value="venta">Venta</option>
                <option value="alquiler">Alquiler</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="label">Estado</span>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="cartera-filter-status">
                <option value="todos">Todos</option>
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {data.statusLabels[s] ?? s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!data.readOnly ? (
            choosing ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="cartera-new-choice">
                <span className="text-sm text-kairikos-muted">¿Qué es?</span>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => create('venta')}>
                  En venta
                </button>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => create('alquiler')}>
                  En alquiler
                </button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setChoosing(false)}>
                  Cancelar
                </button>
              </div>
            ) : (
              <button type="button" className="btn-primary" onClick={() => setChoosing(true)} data-testid="cartera-new">
                Nueva casa
              </button>
            )
          ) : null}
        </div>
        <Notice message={message} />

        {data.pendingSince ? (
          <p className="text-sm text-kairikos-muted">Hay cambios que tu web todavía no tiene: se publican solos.</p>
        ) : null}

        {data.homes.length === 0 ? (
          <p className="card text-sm text-kairikos-muted">Todavía no hay ninguna casa. Con «Nueva casa» das de alta la primera: se guarda como borrador hasta que la completes.</p>
        ) : homes.length === 0 ? (
          <p className="card text-sm text-kairikos-muted">Ninguna casa con esos filtros.</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm" data-testid="cartera-homes">
              <thead className="text-xs text-kairikos-muted">
                <tr className="border-b border-kairikos-border">
                  <th className="px-4 py-2 font-normal">Ref.</th>
                  <th className="px-2 py-2 font-normal">Título</th>
                  <th className="px-2 py-2 font-normal">Estado</th>
                  <th className="px-2 py-2 text-right font-normal">Precio</th>
                  <th className="px-2 py-2 font-normal">Última edición</th>
                  <th className="px-4 py-2 font-normal">Avisos</th>
                </tr>
              </thead>
              <tbody>
                {homes.map((h) => (
                  <tr key={h.id} className="border-b border-kairikos-border last:border-0 hover:bg-kairikos-surface2/60">
                    <td className="whitespace-nowrap px-4 py-2 font-mono">
                      <Link href={`/portal/cartera/${h.id}`} className="underline-offset-2 hover:underline">
                        {h.ref}
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      <Link href={`/portal/cartera/${h.id}`} className="hover:underline">
                        {h.title ?? <span className="text-kairikos-muted">Sin título</span>}
                      </Link>
                      <span className="block text-xs text-kairikos-muted">
                        {OPERATION_LABELS[h.operation] ?? h.operation} · {h.photoCount === 1 ? '1 foto' : `${h.photoCount} fotos`}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span className={statusPill(h.status, h.errors.length > 0)}>{data.statusLabels[h.status] ?? h.status}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{priceText(h.operation, h.price)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-kairikos-muted">{dateTimeText(h.updatedAt)}</td>
                    <td className="px-4 py-2">
                      {h.errors.length > 0 ? (
                        <span className="text-kairikos-warning" title={h.errors.map((e) => e.message).join('\n')}>
                          {h.errors.length === 1 ? h.errors[0].message : `${h.errors[0].message} (y ${h.errors.length - 1} más)`}
                        </span>
                      ) : h.status === 'borrador' ? (
                        <span className="text-kairikos-muted">Lista para publicar</span>
                      ) : (
                        <span className="text-kairikos-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
