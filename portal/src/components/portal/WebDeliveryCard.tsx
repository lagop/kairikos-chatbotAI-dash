'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DeliveryProgress } from '@/lib/web-delivery';

// =============================================================================
// Fase 3 — por dónde va la web del cliente.
//
// El portal se apagaba justo después de cobrar, que es cuando más mira.
// Esto es lo que ve entre el pago y la publicación.
//
// Las etapas se dibujan TODAS, incluidas las que faltan: enseñar solo la
// actual responde «qué estáis haciendo» pero no «cuánto queda», que es la
// pregunta que de verdad genera la llamada.
// =============================================================================

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' });

function StepMark({ status }: { status: string }) {
  if (status === 'done') {
    return (
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-kairikos-success text-[11px] font-bold text-white"
        aria-hidden="true"
      >
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-kairikos-accent"
        aria-hidden="true"
      >
        <span className="h-2 w-2 rounded-full bg-kairikos-accent" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-kairikos-border" aria-hidden="true" />
  );
}

const STATUS_WORD: Record<string, string> = {
  done: 'Terminado',
  in_progress: 'En marcha',
  pending: 'Pendiente',
};

export function WebDeliveryCard({
  progress,
  previewUrl,
  deliveredAt,
  deliveryAcceptedAt,
}: {
  progress: DeliveryProgress;
  previewUrl: string | null;
  deliveredAt: string | null;
  deliveryAcceptedAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/portal/web/accept-delivery', { method: 'POST' });
      if (!res.ok) {
        setError('No se pudo registrar. Si persiste, escríbenos.');
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo registrar. Si persiste, escríbenos.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Cómo va tu web" data-testid="web-delivery-card">
      <div>
        <p className="text-sm font-semibold">Cómo va tu web</p>
        <p className="text-xs text-kairikos-muted">
          {progress.done} de {progress.total} etapas terminadas
          {progress.current ? ` · ahora: ${progress.current.label}` : ''}
        </p>
      </div>

      <ol className="space-y-3" data-testid="web-delivery-steps">
        {progress.milestones.map((step) => (
          <li key={step.key} className="flex gap-3" data-testid="web-delivery-step" data-status={step.status}>
            <StepMark status={step.status} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p
                  className={`text-sm font-medium ${
                    step.status === 'pending' ? 'text-kairikos-muted' : 'text-kairikos-text'
                  }`}
                >
                  {step.label}
                </p>
                <span className="text-xs text-kairikos-muted">
                  {STATUS_WORD[step.status]}
                  {step.completedAt ? ` · ${DATE_FMT.format(new Date(step.completedAt))}` : ''}
                </span>
              </div>
              <p className="text-xs text-kairikos-muted">{step.detail}</p>
              {step.note ? (
                <p className="mt-1 text-xs text-kairikos-warning" data-testid="web-delivery-note">
                  {step.note}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {previewUrl ? (
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3">
          <p className="text-sm font-medium">Tu web, antes de publicarla</p>
          <p className="mt-0.5 text-xs text-kairikos-muted">
            Este enlace es privado: solo lo ve quien lo tenga, y no sale en Google.
          </p>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-kairikos-accent2 hover:underline"
            data-testid="web-delivery-preview"
          >
            Ver la vista previa →
          </a>
        </div>
      ) : null}

      {deliveredAt && !deliveryAcceptedAt ? (
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3">
          <p className="text-sm font-medium">Tu web está lista</p>
          <p className="mt-0.5 text-xs text-kairikos-muted">
            Échale un vistazo con calma. Cuando nos digas que está bien, la damos por entregada — puedes seguir
            pidiéndonos cambios después.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              onClick={accept}
              disabled={busy}
              data-testid="web-delivery-accept"
            >
              {busy ? 'Un momento…' : 'Está todo bien'}
            </button>
            {error ? (
              <span className="text-sm text-kairikos-danger" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {deliveryAcceptedAt ? (
        <p className="text-sm text-kairikos-success" data-testid="web-delivery-accepted">
          Entregada y conforme el {DATE_FMT.format(new Date(deliveryAcceptedAt))}.
        </p>
      ) : null}
    </section>
  );
}
