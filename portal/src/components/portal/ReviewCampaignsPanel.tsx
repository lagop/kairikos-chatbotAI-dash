'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// WP-22b — create/manage review-request campaigns from /portal/resenas.
// The recipient textarea is parsed client-side into a flat list and sent
// as-is to the API — there is no field anywhere in this form for a
// recipient's prior experience or satisfaction (the review-gating policy
// this whole feature has to respect).
// =============================================================================

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  totalRequests: number;
  sent: number;
  failed: number;
  clicked: number;
}

const CONSENT_OPTIONS = [
  { value: 'customer_relationship', label: 'Relación comercial existente (clientes ya atendidos)' },
  { value: 'explicit_consent', label: 'Consentimiento explícito obtenido' },
];

function parseRecipients(raw: string): { email: string; name?: string }[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: { email: string; name?: string }[] = [];
  for (const line of lines) {
    const angleMatch = line.match(/^(.*)<([^>]+)>$/);
    if (angleMatch) {
      const name = angleMatch[1].trim().replace(/,$/, '');
      const email = angleMatch[2].trim();
      out.push({ email, name: name || undefined });
      continue;
    }
    out.push({ email: line });
  }
  return out;
}

export function ReviewCampaignsPanel({ campaigns }: { campaigns: CampaignSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [consentBasis, setConsentBasis] = useState(CONSENT_OPTIONS[0].value);
  const [recipientsText, setRecipientsText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const recipientCount = parseRecipients(recipientsText).length;

  async function submitCampaign(ev: React.FormEvent) {
    ev.preventDefault();
    const recipients = parseRecipients(recipientsText);
    if (!name.trim() || recipients.length === 0) return;
    setBusy('create');
    setMessage(null);
    try {
      const res = await fetch('/api/portal/google-business/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), consentBasis, recipients }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage({ kind: 'error', text: `No se pudo crear la campaña. ${data?.error ?? res.statusText}` });
        return;
      }
      setMessage({ kind: 'success', text: `Campaña creada — ${data.sent + data.skipped} enviadas, ${data.failed} fallidas.` });
      setName('');
      setRecipientsText('');
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus(campaign: CampaignSummary) {
    setBusy(campaign.id);
    try {
      const nextStatus = campaign.status === 'active' ? 'paused' : 'active';
      await fetch(`/api/portal/google-business/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function retryFailed(campaign: CampaignSummary) {
    setBusy(campaign.id);
    try {
      await fetch(`/api/portal/google-business/campaigns/${campaign.id}/retry-failed`, { method: 'POST' });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-y-5" aria-label="Campañas de solicitud de reseñas" data-testid="review-campaigns-panel">
      <header>
        <h2 className="text-lg font-semibold">Campañas de solicitud</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Envía la misma invitación a tus clientes para pedirles una reseña en Google.
        </p>
      </header>

      {message ? (
        <div
          role="status"
          className={
            message.kind === 'success'
              ? 'rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success'
              : 'rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger'
          }
        >
          {message.text}
        </div>
      ) : null}

      <form onSubmit={submitCampaign} className="space-y-3" data-testid="review-campaign-form">
        <div className="space-y-1">
          <label htmlFor="campaign-name" className="label">Nombre de la campaña</label>
          <input
            id="campaign-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clientes de agosto"
            maxLength={200}
            data-testid="review-campaign-name"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="campaign-consent" className="label">Base de consentimiento</label>
          <select
            id="campaign-consent"
            className="input"
            value={consentBasis}
            onChange={(e) => setConsentBasis(e.target.value)}
            data-testid="review-campaign-consent"
          >
            {CONSENT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="campaign-recipients" className="label">
            Destinatarios ({recipientCount}) — uno por línea, &quot;Nombre &lt;email&gt;&quot; o solo el email
          </label>
          <textarea
            id="campaign-recipients"
            className="input min-h-[140px]"
            value={recipientsText}
            onChange={(e) => setRecipientsText(e.target.value)}
            placeholder={'Ana García <ana@example.com>\ncarlos@example.com'}
            data-testid="review-campaign-recipients"
          />
        </div>
        <button
          type="submit"
          className="btn-primary"
          disabled={busy === 'create' || !name.trim() || recipientCount === 0}
          data-testid="review-campaign-submit"
        >
          {busy === 'create' ? 'Enviando…' : `Enviar a ${recipientCount || 0} destinatario${recipientCount === 1 ? '' : 's'}`}
        </button>
      </form>

      {campaigns.length > 0 ? (
        <ul className="space-y-2" data-testid="review-campaign-list">
          {campaigns.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
              data-testid="review-campaign-row"
              data-status={c.status}
            >
              <div>
                <p className="text-sm font-semibold">{c.name}</p>
                <p className="text-xs text-kairikos-muted">
                  {c.sent} enviadas · {c.failed} fallidas · {c.clicked} con clic
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={c.status === 'active' ? 'pill-success' : 'pill-muted'}>
                  {c.status === 'active' ? 'Activa' : 'Pausada'}
                </span>
                {c.failed > 0 ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => retryFailed(c)}
                    disabled={busy === c.id}
                    data-testid="review-campaign-retry"
                  >
                    Reintentar fallidas
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => toggleStatus(c)}
                  disabled={busy === c.id}
                  data-testid="review-campaign-toggle"
                >
                  {c.status === 'active' ? 'Pausar' : 'Reactivar'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
