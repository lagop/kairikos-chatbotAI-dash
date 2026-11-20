'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BUILD_STATUS_LABELS, BUILD_TRIGGER_LABELS } from '@/lib/cartera/publish-rules';
import { Notice, call, dateTimeText, errorMessage, type NoticeMessage } from './cartera-ui';

// =============================================================================
// Cartera — la publicación en el panel (PR 4): el estado de la última encima
// de la tabla de casas, con «Publicar ahora», y la pestaña con el historial.
//
// Las reglas no viven aquí: si se puede lanzar lo decide el servidor
// (lib/cartera/publish-rules.ts, decideLaunch) y el panel enseña su respuesta.
// La única pregunta que hace el panel es la de la salvaguarda de vaciado:
// «Vas a retirar N casas de la web. ¿Publicar?».
// =============================================================================

export interface CarteraBuildRow {
  id: string;
  trigger: string;
  status: string;
  homeCount: number;
  dispatchedAt: string;
  finishedAt: string | null;
  runUrl: string | null;
  error: string | null;
  stage: string | null;
}

export interface CarteraPublicationData {
  /** Repositorio y token de GitHub puestos: sin ellos no se publica nada. */
  configured: boolean;
  /** Contratación activa: en pausa o de baja, la web se queda como está. */
  active: boolean;
  pendingSince: string | null;
  /** Casas que llevaría la web si se publicara ahora. */
  homeCount: number;
  lastPublishedCount: number | null;
  /** La salvaguarda de vaciado está frenando la publicación automática. */
  removing: number | null;
  siteUrl: string | null;
  builds: CarteraBuildRow[];
}

const PUBLISH_ERRORS: Record<string, string> = {
  not_configured: 'Tu web todavía no está conectada para publicarse sola. Kairikos lo está preparando.',
  not_active: 'El servicio no está activo: tu web se queda como está.',
  in_progress: 'Ya hay una publicación en curso. Espera a que acabe.',
  nothing_pending: 'No hay cambios sin publicar.',
  dispatch_failed: 'No se ha podido lanzar la publicación. Kairikos ya está avisado.',
};

function buildPill(status: string): string {
  if (status === 'ok') return 'pill-success';
  if (status === 'fallida') return 'pill-danger';
  if (status === 'desconocida') return 'pill-warning';
  return 'pill-muted';
}

export function PublicationStatus({ data, readOnly }: { data: CarteraPublicationData; readOnly: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage>(null);
  const last = data.builds[0] ?? null;
  const inProgress = last !== null && (last.status === 'enviada' || last.status === 'en_curso');

  async function publish(confirm = false) {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data: body } = await call('POST', '/api/portal/cartera/publicar', confirm ? { confirm: true } : {});
      if (ok) {
        setMessage({ tone: 'ok', text: 'Publicación lanzada. Tu web se actualiza en unos minutos.' });
        router.refresh();
        return;
      }
      if (body.error === 'confirm_removal' && typeof body.removing === 'number') {
        const n = body.removing;
        if (window.confirm(`Vas a retirar ${n} ${n === 1 ? 'casa' : 'casas'} de la web. ¿Publicar?`)) {
          await publish(true);
        }
        return;
      }
      const code = typeof body.error === 'string' ? body.error : '';
      setMessage({ tone: 'error', text: PUBLISH_ERRORS[code] ?? errorMessage(body) });
      if (code === 'in_progress') router.refresh();
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  let summary: string;
  if (!last) summary = 'Tu web todavía no se ha publicado desde aquí.';
  else if (inProgress) summary = `Publicando desde ${dateTimeText(last.dispatchedAt)}…`;
  else summary = `Última publicación: ${BUILD_STATUS_LABELS[last.status] ?? last.status}, ${dateTimeText(last.finishedAt ?? last.dispatchedAt)}.`;

  return (
    <div className="card space-y-2 text-sm" data-testid="cartera-publication-status">
      <div className="flex flex-wrap items-center gap-3">
        {last ? <span className={buildPill(last.status)}>{BUILD_STATUS_LABELS[last.status] ?? last.status}</span> : null}
        <span>{summary}</span>
        {data.siteUrl ? (
          <a href={data.siteUrl} target="_blank" rel="noreferrer noopener" className="underline">
            Ver la web
          </a>
        ) : null}
        {!readOnly && data.configured && data.active ? (
          <button
            type="button"
            className="btn-primary ml-auto"
            disabled={busy || inProgress || !data.pendingSince}
            onClick={() => publish(false)}
            data-testid="cartera-publish-now"
          >
            {busy ? 'Lanzando…' : 'Publicar ahora'}
          </button>
        ) : null}
      </div>
      {last?.status === 'fallida' ? <p className="text-kairikos-danger">{last.error ?? 'La publicación ha fallado.'} Tu web sigue como estaba.</p> : null}
      {last?.status === 'desconocida' ? <p className="text-kairikos-warning">No sabemos cómo acabó la última: puede que tu web se haya actualizado o no.</p> : null}
      {data.removing !== null ? (
        <p className="text-kairikos-warning" data-testid="cartera-publication-hold">
          La próxima publicación retiraría {data.removing} {data.removing === 1 ? 'casa' : 'casas'} de tu web (de {data.lastPublishedCount} a {data.homeCount}). Por si es un error, no
          sale sola: si es lo que quieres, pulsa «Publicar ahora».
        </p>
      ) : data.pendingSince ? (
        <p className="text-kairikos-muted">
          {data.configured && data.active
            ? 'Hay cambios que tu web todavía no tiene: se publican solos en unos minutos.'
            : 'Hay cambios que tu web todavía no tiene.'}
        </p>
      ) : last ? (
        <p className="text-kairikos-muted">Tu web está al día.</p>
      ) : null}
      {!data.configured ? <p className="text-kairikos-muted">{PUBLISH_ERRORS.not_configured}</p> : null}
      <Notice message={message} />
    </div>
  );
}

export function PublicationHistory({ builds }: { builds: CarteraBuildRow[] }) {
  if (builds.length === 0) return <p className="card text-sm text-kairikos-muted">Todavía no hay ninguna publicación.</p>;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-left text-sm" data-testid="cartera-builds">
        <thead className="text-xs text-kairikos-muted">
          <tr className="border-b border-kairikos-border">
            <th className="px-4 py-2 font-normal">Fecha</th>
            <th className="px-2 py-2 font-normal">Origen</th>
            <th className="px-2 py-2 text-right font-normal">Casas</th>
            <th className="px-2 py-2 font-normal">Estado</th>
            <th className="px-2 py-2 font-normal">Detalle</th>
            <th className="px-4 py-2 font-normal">Ejecución</th>
          </tr>
        </thead>
        <tbody>
          {builds.map((b) => (
            <tr key={b.id} className="border-b border-kairikos-border last:border-0 align-top">
              <td className="whitespace-nowrap px-4 py-2">{dateTimeText(b.dispatchedAt)}</td>
              <td className="whitespace-nowrap px-2 py-2">{BUILD_TRIGGER_LABELS[b.trigger] ?? b.trigger}</td>
              <td className="px-2 py-2 text-right tabular-nums">{b.homeCount}</td>
              <td className="whitespace-nowrap px-2 py-2">
                <span className={buildPill(b.status)}>{BUILD_STATUS_LABELS[b.status] ?? b.status}</span>
              </td>
              <td className="px-2 py-2 text-kairikos-muted">
                {b.error ?? (b.finishedAt && b.status === 'ok' ? `Terminó ${dateTimeText(b.finishedAt)}` : '—')}
              </td>
              <td className="whitespace-nowrap px-4 py-2">
                {b.runUrl ? (
                  <a href={b.runUrl} target="_blank" rel="noreferrer noopener" className="underline">
                    Ver
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
