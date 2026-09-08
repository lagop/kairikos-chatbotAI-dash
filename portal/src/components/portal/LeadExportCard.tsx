'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Fase 4 — sacar los leads del portal.
//
// Dos salidas en una tarjeta porque responden a la misma necesidad con
// distinto esfuerzo: la descarga no exige configurar nada y sirve hoy; el
// webhook exige pegar una URL y hace que no haya que volver a entrar.
//
// El secreto se enseña UNA vez, al guardarlo. No se puede volver a leer: un
// secreto recuperable desde una pantalla que se comparte por captura deja
// de ser un secreto, y regenerarlo es una acción de dos clics.
// =============================================================================

export interface LeadWebhookState {
  url: string;
  enabled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryError: string | null;
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const ERROR_LABEL: Record<string, string> = {
  invalid_url: 'Esa dirección no parece válida. Cópiala otra vez desde tu CRM.',
  invalid_body: 'Falta la dirección a la que enviar.',
  forbidden: 'Tu cuenta no tiene acceso al buzón de leads.',
  save_failed: 'No se pudo guardar. Si persiste, escríbenos.',
  delete_failed: 'No se pudo quitar. Si persiste, escríbenos.',
};

export function LeadExportCard({ webhook }: { webhook: LeadWebhookState | null }) {
  const router = useRouter();
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function save(rotateSecret = false) {
    setError(null);
    setSecret(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/leads/webhook', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), rotateSecret }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; secret?: string | null } | null;
      if (!res.ok) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? ERROR_LABEL.save_failed);
        return;
      }
      if (json?.secret) setSecret(json.secret);
      router.refresh();
    } catch {
      setError(ERROR_LABEL.save_failed);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setSecret(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/leads/webhook', { method: 'DELETE' });
      if (!res.ok) {
        setError(ERROR_LABEL.delete_failed);
        return;
      }
      setUrl('');
      router.refresh();
    } catch {
      setError(ERROR_LABEL.delete_failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-5" aria-label="Llevarte tus leads" data-testid="lead-export-card">
      <div>
        <p className="text-sm font-semibold">Llevarte tus leads</p>
        <p className="text-xs text-kairikos-muted">
          Son tuyos. Descárgalos cuando quieras, o dinos a dónde mandarlos y llegarán solos a tu CRM.
        </p>
      </div>

      <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3">
        <p className="text-sm font-medium">Descargar ahora</p>
        <p className="mt-0.5 text-xs text-kairikos-muted">
          Un archivo CSV con todos tus leads, listo para abrir en Excel.
        </p>
        <a
          href="/api/portal/leads/export"
          className="mt-2 inline-block text-sm text-kairikos-accent2 hover:underline"
          data-testid="lead-export-download"
        >
          Descargar CSV →
        </a>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Enviarlos a tu CRM</p>
          <p className="mt-0.5 text-xs text-kairikos-muted">
            Cada vez que entre un lead te lo mandamos a esta dirección. Sirve cualquier CRM que acepte webhooks, y
            también Zapier, Make o n8n.
          </p>
        </div>

        <label className="block">
          <span className="text-sm text-kairikos-muted">Dirección de tu CRM</span>
          <input
            className="input mt-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="hooks.micrm.com/kairikos/leads"
            data-testid="lead-webhook-url"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => save(false)}
            disabled={busy || url.trim().length < 4}
            data-testid="lead-webhook-save"
          >
            {busy ? 'Guardando…' : webhook ? 'Guardar cambios' : 'Activar envío'}
          </button>
          {webhook ? (
            <>
              <button
                type="button"
                className="btn border border-kairikos-border text-sm"
                onClick={() => save(true)}
                disabled={busy}
                data-testid="lead-webhook-rotate"
              >
                Generar clave nueva
              </button>
              <button
                type="button"
                className="btn border border-kairikos-border text-sm"
                onClick={remove}
                disabled={busy}
                data-testid="lead-webhook-remove"
              >
                Quitar
              </button>
            </>
          ) : null}
          {error ? (
            <span className="text-sm text-kairikos-danger" role="alert">
              {error}
            </span>
          ) : null}
        </div>

        {secret ? (
          <div className="rounded-xl border border-kairikos-accent/40 bg-kairikos-accent/10 p-3" data-testid="lead-webhook-secret">
            <p className="text-sm font-medium">Copia esta clave ahora</p>
            <p className="mt-0.5 text-xs text-kairikos-muted">
              No vas a poder volver a verla. Con ella tu CRM comprueba que el aviso lo mandamos nosotros: va en la
              cabecera <code className="text-xs">x-kairikos-signature</code>.
            </p>
            <code className="mt-2 block break-all rounded-lg bg-kairikos-surface2 p-2 text-xs">{secret}</code>
          </div>
        ) : null}

        {webhook ? (
          <p className="text-xs text-kairikos-muted" data-testid="lead-webhook-status">
            {webhook.lastDeliveryError ? (
              <span className="text-kairikos-warning">
                El último envío falló{webhook.lastDeliveryAt ? ` el ${DATE_FMT.format(new Date(webhook.lastDeliveryAt))}` : ''}.
                Lo reintentamos solos varias veces.
              </span>
            ) : webhook.lastDeliveryAt ? (
              `Último envío correcto el ${DATE_FMT.format(new Date(webhook.lastDeliveryAt))}.`
            ) : (
              'Todavía no hemos mandado ninguno: el próximo lead que entre irá también aquí.'
            )}
          </p>
        ) : null}
      </div>
    </section>
  );
}
