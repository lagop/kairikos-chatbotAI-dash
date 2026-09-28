'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Recuperación dentro de `recall` — crear, revisar y aprobar campañas.
//
// EL ORDEN DE LA PANTALLA ES EL ORDEN DE LA DECISIÓN:
//
//   1. Cuántos candidatos hay por disparador, Y CUÁNTOS SE HAN EXCLUIDO Y
//      POR QUÉ. Lo segundo no es un detalle: "12 sin base legal" es lo que
//      le dice al operador que la base importada todavía no sirve, antes de
//      que crea que la campaña va a llegar a más gente de la que llegará.
//   2. Crear el borrador, que congela la lista.
//   3. Revisar la lista congelada, persona a persona, con el motivo que se
//      le va a dar a cada una.
//   4. Aprobar. Solo entonces el cron la envía.
//
// APROBAR PIDE CONFIRMACIÓN con el número de destinatarios delante. Es el
// único botón del panel que acaba escribiendo a clientes reales del
// profesional, y un clic de más ahí no se deshace.
// =============================================================================

export interface TriggerPreview {
  trigger: 'open_quote' | 'service_anniversary' | 'dormant';
  candidates: number;
  excluded: Record<string, number>;
}

export interface CampaignView {
  id: string;
  trigger: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  approvedByEmail: string | null;
  counts: { pending: number; sent: number; failed: number; excluded: number };
  members: Array<{ id: string; e164: string; name: string | null; reason: string; state: string; excludedReason: string | null }>;
}

const TRIGGER_LABEL: Record<string, string> = {
  open_quote: 'Presupuestos sin respuesta',
  service_anniversary: 'Revisiones que vencen',
  dormant: 'Clientes dormidos',
};

const TRIGGER_HINT: Record<string, string> = {
  open_quote: 'Presupuestos abiertos de más de una semana y menos de seis meses, aún no perseguidos.',
  service_anniversary: 'Trabajos cuya próxima revisión vence en los próximos 30 días.',
  dormant: 'Contactos sin ningún trato en más de 18 meses. Mensaje de marketing: el más caro.',
};

const EXCLUSION_LABEL: Record<string, string> = {
  suppressed: 'pidieron la baja',
  no_legal_basis: 'sin base legal',
  legal_basis_stale: 'base legal caducada',
  contacted_recently: 'escritos hace poco',
  callback_scheduled: 'con devolución agendada',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  approved: 'Aprobada · enviándose',
  completed: 'Terminada',
  cancelled: 'Cancelada',
};

const STATE_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  sent: 'Enviado',
  failed: 'Falló',
  excluded: 'Excluido',
};

const ERROR_LABEL: Record<string, string> = {
  not_draft: 'Esta campaña ya no está en borrador.',
  not_cancellable: 'Esta campaña ya ha terminado y no se puede cancelar.',
  no_candidates: 'Ahora mismo no hay nadie a quien escribir con este disparador.',
};

export function RecoveryCampaignsCard({
  subscriptionId,
  previews,
  campaigns,
}: {
  subscriptionId: string;
  previews: TriggerPreview[];
  campaigns: CampaignView[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const call = async (key: string, url: string, body: unknown) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setError(ERROR_LABEL[json?.error] ?? 'No se ha podido completar la acción.');
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const approve = (c: CampaignView) => {
    const n = c.counts.pending;
    const ok = window.confirm(
      `Vas a aprobar el envío a ${n} ${n === 1 ? 'persona' : 'personas'} (${TRIGGER_LABEL[c.trigger] ?? c.trigger}).\n\n` +
        'Antes de cada envío se vuelve a comprobar si alguien pidió la baja, pero el mensaje sale en nombre del cliente y no se puede retirar.\n\n¿Aprobar?',
    );
    if (ok) void call(`approve-${c.id}`, `/api/admin/portal/recall/recovery/${c.id}`, { action: 'approve' });
  };

  return (
    <div className="space-y-6" data-testid="recovery-campaigns">
      {/* Arriba del todo y no dentro de una tarjeta: el error puede venir de
          crear un borrador o de aprobar una campaña, y tiene que verse sin
          depender de dónde esté el scroll. */}
      {error ? (
        <p className="card text-sm text-kairikos-danger" role="alert" data-testid="recovery-campaigns-error">
          {error}
        </p>
      ) : null}
      <div className="card space-y-4">
        <div>
          <h2 className="text-base font-semibold">A quién se podría escribir ahora</h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Recuento en seco: no se crea ni se envía nada hasta que crees un borrador y lo apruebes.
          </p>
        </div>

        <ul className="space-y-3">
          {previews.map((p) => {
            const excludedTotal = Object.values(p.excluded).reduce((a, b) => a + b, 0);
            return (
              <li
                key={p.trigger}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-kairikos-border pt-3"
                data-testid={`recovery-preview-${p.trigger}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{TRIGGER_LABEL[p.trigger]}</p>
                  <p className="text-xs text-kairikos-muted">{TRIGGER_HINT[p.trigger]}</p>
                  <p className="mt-1 text-sm">
                    <strong className="tabular-nums">{p.candidates}</strong> a quien escribir
                    {excludedTotal > 0 ? (
                      <span className="text-kairikos-muted">
                        {' · '}
                        {excludedTotal} excluidos (
                        {Object.entries(p.excluded)
                          .map(([reason, n]) => `${n} ${EXCLUSION_LABEL[reason] ?? reason}`)
                          .join(', ')}
                        )
                      </span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={p.candidates === 0 || busy !== null}
                  onClick={() =>
                    void call(`draft-${p.trigger}`, `/api/admin/portal/recall/${subscriptionId}/recovery/drafts`, {
                      trigger: p.trigger,
                    })
                  }
                  data-testid={`recovery-draft-${p.trigger}`}
                >
                  {busy === `draft-${p.trigger}` ? 'Creando…' : 'Crear borrador'}
                </button>
              </li>
            );
          })}
        </ul>

      </div>

      <div className="card space-y-4">
        <h2 className="text-base font-semibold">Campañas</h2>
        {campaigns.length === 0 ? (
          <p className="text-sm text-kairikos-muted">Todavía no se ha creado ninguna.</p>
        ) : (
          <ul className="space-y-4">
            {campaigns.map((c) => (
              <li key={c.id} className="space-y-2 border-t border-kairikos-border pt-3" data-testid="recovery-campaign" data-status={c.status}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{TRIGGER_LABEL[c.trigger] ?? c.trigger}</p>
                    <p className="text-xs text-kairikos-muted">
                      {STATUS_LABEL[c.status] ?? c.status} · creada el {c.createdAt.slice(0, 10)}
                      {c.approvedByEmail ? ` · aprobada por ${c.approvedByEmail}` : ''}
                    </p>
                    <p className="mt-1 text-xs tabular-nums">
                      {c.counts.pending} pendientes · {c.counts.sent} enviados · {c.counts.failed} fallidos ·{' '}
                      {c.counts.excluded} excluidos al enviar
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {c.status === 'draft' ? (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy !== null || c.counts.pending === 0}
                        onClick={() => approve(c)}
                        data-testid="recovery-approve"
                      >
                        {busy === `approve-${c.id}` ? 'Aprobando…' : 'Aprobar envío'}
                      </button>
                    ) : null}
                    {c.status === 'draft' || c.status === 'approved' ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy !== null}
                        onClick={() => void call(`cancel-${c.id}`, `/api/admin/portal/recall/recovery/${c.id}`, { action: 'cancel' })}
                        data-testid="recovery-cancel"
                      >
                        Cancelar
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="text-sm text-kairikos-muted underline"
                      onClick={() => setOpen(open === c.id ? null : c.id)}
                    >
                      {open === c.id ? 'Ocultar destinatarios' : 'Ver destinatarios'}
                    </button>
                  </div>
                </div>

                {open === c.id ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-kairikos-muted">
                          <th className="py-1 pr-3">Contacto</th>
                          <th className="py-1 pr-3">Motivo</th>
                          <th className="py-1 pr-3">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.members.map((m) => (
                          <tr key={m.id} className="border-t border-kairikos-border">
                            <td className="py-1 pr-3">
                              {m.name ?? '—'} <span className="tabular-nums text-kairikos-muted">{m.e164}</span>
                            </td>
                            <td className="py-1 pr-3">{m.reason}</td>
                            <td className="py-1 pr-3">
                              {STATE_LABEL[m.state] ?? m.state}
                              {m.excludedReason ? ` (${EXCLUSION_LABEL[m.excludedReason] ?? m.excludedReason})` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
