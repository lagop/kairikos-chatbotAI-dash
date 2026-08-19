'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP: conexión de canales — Fase 5. Solo-lectura del estado de canales
// para el operador, más dos acciones puntuales: reintento manual de un
// ChannelWebhookDelivery atascado en `failed` (más allá del techo de
// reintentos automáticos del cron), y un aviso visible (no acción
// automática) cuando una conexión activa quedó fuera del tier actual
// del cliente tras un downgrade — ver el plan, sección "Downgrade de
// tier": el operador decide qué hacer, no se corta nada solo.
// =============================================================================

type ChannelCode = 'web' | 'telegram' | 'whatsapp' | 'messenger' | 'instagram';
type ConnectionStatus = 'active' | 'needs_reconnect' | 'revoked';

export interface TelegramConnectionRow {
  status: ConnectionStatus;
  botUsername: string;
}

export interface MetaConnectionRow {
  id: string;
  channel: 'whatsapp' | 'messenger' | 'instagram';
  externalId: string;
  label: string | null;
  status: ConnectionStatus;
}

export interface FailedDeliveryRow {
  id: string;
  connectionType: 'web' | 'telegram' | 'meta';
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

const STATUS_PILL: Record<ConnectionStatus, string> = {
  active: 'pill-success',
  needs_reconnect: 'pill-warning',
  revoked: 'pill-muted',
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  active: 'Conectado',
  needs_reconnect: 'Necesita reconexión',
  revoked: 'Desconectado',
};

const CHANNEL_LABEL: Record<ChannelCode, string> = {
  web: 'Web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

const CONNECTION_TYPE_LABEL: Record<FailedDeliveryRow['connectionType'], string> = {
  web: 'Web',
  telegram: 'Telegram',
  meta: 'Meta',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ChannelsOperatorPanel({
  telegram,
  meta,
  allowedChannels,
  failedDeliveries,
}: {
  telegram: TelegramConnectionRow | null;
  meta: MetaConnectionRow[];
  allowedChannels: string[];
  failedDeliveries: FailedDeliveryRow[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows: Array<{ key: string; channel: ChannelCode; label: string; status: ConnectionStatus }> = [];
  if (telegram) {
    rows.push({ key: 'telegram', channel: 'telegram', label: telegram.botUsername, status: telegram.status });
  }
  for (const c of meta) {
    rows.push({ key: c.id, channel: c.channel, label: c.label ?? c.externalId, status: c.status });
  }

  async function retry(deliveryId: string) {
    setError(null);
    setBusyId(deliveryId);
    try {
      const res = await fetch(`/api/admin/portal/channels/webhook-deliveries/${deliveryId}/retry`, { method: 'POST' });
      if (!res.ok) {
        setError('No se pudo reintentar la entrega.');
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusyId(null);
    }
  }

  if (rows.length === 0 && failedDeliveries.length === 0) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="channels-panel-empty">
        Este cliente no tiene ningún canal conectado todavía.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="channels-operator-panel">
      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => {
            const outOfTier = row.status === 'active' && !allowedChannels.includes(row.channel);
            return (
              <li
                key={row.key}
                className="flex flex-col gap-1 rounded-lg border border-kairikos-border px-3 py-2"
                data-testid="channel-row"
                data-channel={row.channel}
                data-status={row.status}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-kairikos-text">
                    <span className="font-semibold">{CHANNEL_LABEL[row.channel]}</span> — {row.label}
                  </span>
                  <span className={STATUS_PILL[row.status]}>{STATUS_LABEL[row.status]}</span>
                </div>
                {outOfTier ? (
                  <p className="text-xs text-kairikos-danger" data-testid="channel-out-of-tier-warning">
                    Este canal ya no está incluido en el tier actual del cliente — quedó activo tras un cambio de
                    plan. No se desconecta solo; decide si desconectarlo o si el cliente necesita subir de tier.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {failedDeliveries.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-kairikos-text">Entregas fallidas hacia n8n</h3>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="channels-retry-error">
              {error}
            </p>
          ) : null}
          <ul className="space-y-2">
            {failedDeliveries.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-kairikos-border px-3 py-2"
                data-testid="failed-delivery-row"
              >
                <div className="text-sm text-kairikos-text">
                  <p>
                    <span className="font-semibold">{CONNECTION_TYPE_LABEL[d.connectionType]}</span> — {d.attempts}{' '}
                    intento{d.attempts === 1 ? '' : 's'}
                    {d.lastAttemptAt ? ` · último intento ${DATE_FMT.format(new Date(d.lastAttemptAt))}` : ''}
                  </p>
                  {d.lastError ? <p className="text-xs text-kairikos-muted">{d.lastError}</p> : null}
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => retry(d.id)}
                  disabled={busyId === d.id}
                  data-testid="retry-delivery-button"
                >
                  {busyId === d.id ? 'Reintentando…' : 'Reintentar'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
