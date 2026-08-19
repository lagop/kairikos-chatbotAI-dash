'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP: conexión de canales — Fase 2. First real channel card: the client
// pastes their own @BotFather token, we validate it server-side (Bot
// API's getMe) before saving. Same busy/error/router.refresh() shape as
// RequestWebQuoteCard.tsx — same-page action, refresh instead of push.
// =============================================================================

export interface TelegramConnectionSummary {
  status: 'active' | 'needs_reconnect' | 'revoked';
  botUsername: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_token: 'Ese token no es válido. Revisa que lo copiaste completo desde @BotFather.',
  channel_not_in_plan: 'Telegram no está incluido en tu plan actual.',
  forbidden: 'Este producto no está disponible ahora mismo.',
  telegram_api_error: 'No se pudo verificar el token con Telegram. Intenta de nuevo en un momento.',
  service_unavailable: 'No disponible en este momento — contacta con soporte.',
};

export function TelegramChannelCard({
  connection,
  allowed,
}: {
  connection: TelegramConnectionSummary | null;
  allowed: boolean;
}) {
  const router = useRouter();
  const tokenId = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConnected = connection?.status === 'active';

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/telegram/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botToken: token }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo conectar el canal.');
        setBusy(false);
        return;
      }
      setToken('');
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/channels/telegram/disconnect', { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo desconectar el canal.');
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3" data-testid="telegram-channel-card" data-status={connection?.status ?? 'disconnected'}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Telegram</h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Conecta tu chatbot a un bot de Telegram creado por ti mismo con @BotFather.
          </p>
        </div>
        {isConnected ? <span className="pill-success">Conectado</span> : null}
        {connection?.status === 'needs_reconnect' ? <span className="pill-warning">Necesita reconexión</span> : null}
      </div>

      {!allowed ? (
        <p className="text-sm text-kairikos-muted" data-testid="telegram-locked">
          Telegram no está incluido en tu plan actual. Contacta con soporte para ampliar tu plan de chatbot.
        </p>
      ) : isConnected ? (
        <>
          <p className="text-sm text-kairikos-text">
            Bot conectado: <span className="font-semibold">@{connection.botUsername}</span>
          </p>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="telegram-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            onClick={disconnect}
            disabled={busy}
            data-testid="telegram-disconnect-button"
          >
            {busy ? 'Desconectando…' : 'Desconectar'}
          </button>
        </>
      ) : (
        <form onSubmit={connect} className="space-y-3">
          <div>
            <label htmlFor={tokenId} className="label">
              Token del bot
            </label>
            <input
              id={tokenId}
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AAExampleTokenFromBotFather"
              className="input"
              autoComplete="off"
              required
              data-testid="telegram-token-input"
            />
          </div>
          {error ? (
            <p className="text-sm text-kairikos-danger" data-testid="telegram-error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn-primary" disabled={busy} data-testid="telegram-connect-button">
            {busy ? 'Conectando…' : 'Conectar'}
          </button>
        </form>
      )}
    </div>
  );
}
