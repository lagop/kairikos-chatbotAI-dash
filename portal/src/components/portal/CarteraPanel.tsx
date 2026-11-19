'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice, ReadOnlyBanner, call, dateTimeText, errorMessage, priceText, type NoticeMessage } from './cartera-ui';
import { PublicationHistory, PublicationStatus, type CarteraPublicationData } from './CarteraPublication';
import { CarteraEnquiries, type CarteraEnquiryRow } from './CarteraEnquiries';

// =============================================================================
// Cartera — el panel de la agencia. Los datos llegan preparados de
// /portal/cartera/page.tsx.
//
//   - Casas (PR 2): «Nueva casa» crea el borrador por POST
//     /api/portal/cartera/casas y abre su ficha (/portal/cartera/<id>). Encima
//     de la tabla, el estado de la última publicación y «Publicar ahora» (PR 4).
//   - Contactos (PR 5): lo que llega de la web (CarteraEnquiries.tsx).
//   - Publicación (PR 4): el historial (CarteraPublication.tsx).
//
// Exportar llega con su PR. Los paneles están SIEMPRE
// montados y el que no toca lleva `hidden`, como en VillasPanel: cambiar de
// pestaña no pierde los filtros.
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
  statusLabels: Record<string, string>;
  statuses: { venta: readonly string[]; alquiler: readonly string[] };
  homes: CarteraPanelRow[];
  publication: CarteraPublicationData;
  enquiries: CarteraEnquiryRow[];
  enquiryKindLabels: Record<string, string>;
}

type TabId = 'casas' | 'contactos' | 'publicacion';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'casas', label: 'Casas' },
  { id: 'contactos', label: 'Contactos' },
  { id: 'publicacion', label: 'Publicación' },
];

const OPERATION_LABELS: Record<string, string> = { venta: 'Venta', alquiler: 'Alquiler' };

function statusPill(status: string, hasErrors: boolean): string {
  if (status === 'borrador') return 'pill-muted';
  if (hasErrors) return 'pill-warning';
  if (status === 'vendida' || status === 'alquilada') return 'pill-muted';
  return 'pill-success';
}

export function CarteraPanel({ data }: { data: CarteraPanelData }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('casas');
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

  const newEnquiries = data.enquiries.filter((e) => e.status === 'nuevo').length;
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
        {TABS.map((t) => {
          const selected = t.id === tab;
          const last = data.publication.builds[0];
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`cartera-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`cartera-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              data-testid={`cartera-tab-${t.id}`}
              className={[
                'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition',
                selected ? 'border-kairikos-accent font-semibold text-kairikos-text' : 'border-transparent text-kairikos-muted hover:border-kairikos-border hover:text-kairikos-text',
              ].join(' ')}
            >
              {t.label}
              {t.id === 'casas' ? <span className="pill-muted">{data.homes.length}</span> : null}
              {t.id === 'contactos' && newEnquiries > 0 ? <span className="pill-warning">{newEnquiries}</span> : null}
              {t.id === 'publicacion' && last?.status === 'fallida' ? <span className="pill-danger">Fallida</span> : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="cartera-panel-casas" aria-labelledby="cartera-tab-casas" hidden={tab !== 'casas'} className="mt-6 space-y-4">
        <PublicationStatus data={data.publication} readOnly={data.readOnly} />

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

      <div role="tabpanel" id="cartera-panel-contactos" aria-labelledby="cartera-tab-contactos" hidden={tab !== 'contactos'} className="mt-6">
        <CarteraEnquiries rows={data.enquiries} kindLabels={data.enquiryKindLabels} readOnly={data.readOnly} />
      </div>

      <div role="tabpanel" id="cartera-panel-publicacion" aria-labelledby="cartera-tab-publicacion" hidden={tab !== 'publicacion'} className="mt-6 space-y-4">
        <p className="max-w-2xl text-sm text-kairikos-muted">
          Cada publicación reconstruye tu web con las casas que no son borrador y no tienen avisos. Si una falla, la web anterior sigue en pie y se te avisa por correo.
        </p>
        <PublicationHistory builds={data.publication.builds} />
      </div>
    </div>
  );
}
