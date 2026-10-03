'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Plan de precios del 01/10/2026 — Ficha de Google gestionada: la oferta, o
// la publicación de esta semana con el veto del cliente (lib/gbp-managed.ts).
//
// «Publicar salvo veto», como los artículos SEO: el borrador sale solo al
// cumplir el plazo. Aquí se puede editar (no publica), publicar ya o
// descartar.
// =============================================================================

export interface GbpManagedCardProps {
  connectionId: string | null;
  from: 'resenas' | 'seo';
  offer: { priceCents: number; annualPriceCents: number | null; currency: string } | null;
  managed: boolean;
  draft: { id: string; summary: string; publishAfter: string; held: boolean } | null;
  lastPublished: { summary: string; publishedAt: string } | null;
  lastFailed: { error: string | null } | null;
  /** ?checkout=success de la vuelta de Stripe. */
  checkoutReturn: string | null;
}

const DATE = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

const ERROR_LABEL: Record<string, string> = {
  not_on_sale: 'La Ficha gestionada todavía no está disponible. Escríbenos y la activamos.',
  already_managed: 'Esta ficha ya está gestionada.',
  annual_price_missing: 'El pago anual aún no está disponible. Puedes contratarla al mes.',
  publish_failed: 'Google no aceptó la publicación. Lo revisamos nosotros.',
  not_publishable: 'Esta publicación ya no se puede publicar.',
  not_editable: 'Esta publicación ya no se puede cambiar.',
};

export function GbpManagedCard(props: GbpManagedCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(props.draft?.summary ?? '');
  const [notice, setNotice] = useState<string | null>(null);

  async function buy(billing: 'monthly' | 'annual') {
    setBusy(billing);
    setError(null);
    try {
      const res = await fetch('/api/portal/gbp-managed/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: props.connectionId, billing, from: props.from }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? 'No se pudo abrir el pago. Inténtalo de nuevo.');
        setBusy(null);
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Error de red. Inténtalo de nuevo.');
      setBusy(null);
    }
  }

  async function act(body: Record<string, unknown>, key: string) {
    if (!props.draft) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/portal/gbp-managed/posts/${props.draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; held?: boolean } | null;
      if (!res.ok) {
        setError(ERROR_LABEL[json?.error ?? ''] ?? 'No se pudo guardar. Inténtalo de nuevo.');
        return;
      }
      if (json?.held) {
        setNotice('Guardado. Lleva un enlace, un teléfono o un correo: no se publicará sola hasta que lo quites.');
      }
      router.refresh();
    } catch {
      setError('Error de red. Inténtalo de nuevo.');
    } finally {
      setBusy(null);
    }
  }

  if (!props.managed) {
    if (!props.offer) return null;
    return (
      <section className="card space-y-3" aria-label="Ficha de Google gestionada" data-testid="gbp-managed-card" data-state="offer">
        <div>
          <p className="text-sm font-semibold">Ficha de Google gestionada</p>
          <p className="mt-0.5 text-sm text-kairikos-muted">
            Una publicación a la semana en tu ficha y respuesta a cada reseña, sin que tengas que entrar. Te enseñamos cada
            publicación antes y tienes dos días para cambiarla o descartarla.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => buy('monthly')} data-testid="gbp-managed-monthly">
            {busy === 'monthly' ? 'Redirigiendo a Stripe…' : `Contratar · ${money(props.offer.priceCents, props.offer.currency)}/mes`}
          </button>
          {props.offer.annualPriceCents ? (
            <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => buy('annual')} data-testid="gbp-managed-annual">
              {busy === 'annual' ? 'Redirigiendo a Stripe…' : `o ${money(props.offer.annualPriceCents, props.offer.currency)}/año`}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="text-sm text-kairikos-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="card space-y-3" aria-label="Ficha de Google gestionada" data-testid="gbp-managed-card" data-state="managed">
      <div>
        <p className="text-sm font-semibold">Ficha de Google gestionada</p>
        <p className="mt-0.5 text-sm text-kairikos-muted">
          {props.connectionId
            ? 'Publicamos una vez por semana en tu ficha y respondemos a tus reseñas.'
            : 'Contratada. Conecta tu ficha de Google aquí arriba y empezamos.'}
        </p>
      </div>
      {props.checkoutReturn === 'success' ? (
        <p className="text-sm text-kairikos-accent2" role="status">
          Pago recibido. La primera publicación se prepara en las próximas horas.
        </p>
      ) : null}
      {props.draft ? (
        <div className="space-y-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3" data-testid="gbp-managed-draft">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">
            {props.draft.held
              ? 'Publicación de esta semana · esperando que la revises'
              : `Publicación de esta semana · sale el ${DATE.format(new Date(props.draft.publishAfter))}`}
          </p>
          {props.draft.held ? (
            <p className="text-xs text-kairikos-warning">
              Lleva un enlace, un teléfono o un correo, así que no saldrá sola: revísala y publícala tú.
            </p>
          ) : null}
          <textarea
            className="input min-h-[120px] w-full"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1500}
            data-testid="gbp-managed-draft-text"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost text-sm"
              disabled={busy !== null || text.trim() === props.draft.summary.trim() || text.trim().length < 40}
              onClick={() => act({ action: 'edit', summary: text }, 'edit')}
            >
              {busy === 'edit' ? 'Guardando…' : 'Guardar cambios'}
            </button>
            <button type="button" className="btn-primary text-sm" disabled={busy !== null} onClick={() => act({ action: 'publish' }, 'publish')}>
              {busy === 'publish' ? 'Publicando…' : 'Publicar ya'}
            </button>
            <button type="button" className="btn-ghost text-sm" disabled={busy !== null} onClick={() => act({ action: 'reject' }, 'reject')}>
              {busy === 'reject' ? 'Descartando…' : 'No publicar esta'}
            </button>
          </div>
        </div>
      ) : props.connectionId ? (
        <p className="text-sm text-kairikos-muted">La próxima publicación se prepara a lo largo de la semana.</p>
      ) : null}
      {props.lastFailed ? (
        <p className="text-sm text-kairikos-warning">La última publicación no se pudo subir a Google. Lo estamos revisando.</p>
      ) : null}
      {props.lastPublished ? (
        <div className="text-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">
            Última publicada · {DATE.format(new Date(props.lastPublished.publishedAt))}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-kairikos-muted">{props.lastPublished.summary}</p>
        </div>
      ) : null}
      {notice ? (
        <p className="text-sm text-kairikos-warning" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
