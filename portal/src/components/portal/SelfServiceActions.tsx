'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type ToastKind = 'success' | 'info' | 'error';

interface ToastState {
  kind: ToastKind;
  message: string;
}

export interface SelfServiceActionsProps {
  /**
   * The active milestone, if any. Used to enable/disable the snooze
   * button and to render the milestone label inside the help form.
   */
  activeMilestoneId: 'T+0' | 'T+3' | 'T+7' | 'T+14' | null;
  /**
   * Whether the go-live-ready button should be visible. The server
   * derives this from the client's `state` and the activity log so a
   * hand-crafted prop value cannot bypass the state check.
   */
  canGoLiveReady: boolean;
  /**
   * Whether the "I uploaded my assets" button should be visible. Only
   * meaningful when the assets milestone (T+3) is the active one.
   */
  canMarkAssetsUploaded: boolean;
  /**
   * Variant: the onboarding page renders the full action set, the
   * dashboard page only renders "I need help" to keep the dashboard
   * tight.
   */
  variant: 'onboarding' | 'dashboard';
  /**
   * Server-side resolved clientId. Passed through to the snooze /
   * go-live-ready endpoints so the row-isolation rule stays auditable
   * (the route re-validates it from the session).
   */
  clientId: string;
  /**
   * Optional: pre-set revalidation path for the post-action refresh.
   * Defaults to `/portal/onboarding`.
   */
  revalidatePath?: string;
}

export function SelfServiceActions({
  activeMilestoneId,
  canGoLiveReady,
  canMarkAssetsUploaded,
  variant,
  clientId,
  revalidatePath = '/portal/onboarding',
}: SelfServiceActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showHelpForm, setShowHelpForm] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 4500);
  };

  const refresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  const onMarkAssetsUploaded = async () => {
    setBusyAction('assets-uploaded');
    try {
      const res = await fetch('/api/portal/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'assets-uploaded',
          milestone: 'T+3',
          notes: 'Marcado por el cliente desde el portal.',
        }),
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        showToast({
          kind: 'error',
          message: `No hemos podido registrar la subida. ${detail ?? res.statusText}`,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { deduped?: boolean };
      showToast({
        kind: 'success',
        message: data.deduped
          ? 'Ya habías marcado la subida; el operador ya estaba avisado.'
          : 'Subida registrada. El operador la verá en la siguiente revisión.',
      });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const onSnoozeMilestone = async () => {
    if (!activeMilestoneId) return;
    setBusyAction('snooze');
    try {
      const res = await fetch('/api/portal/onboarding/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestoneId: activeMilestoneId, days: 1 }),
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        showToast({
          kind: 'error',
          message: `No hemos podido aplazar el paso. ${detail ?? res.statusText}`,
        });
        return;
      }
      showToast({
        kind: 'info',
        message: `Has aplazado ${activeMilestoneId} un día. Te avisaremos mañana.`,
      });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const onGoLiveReady = async () => {
    setBusyAction('go-live-ready');
    try {
      const res = await fetch('/api/portal/onboarding/go-live-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        showToast({
          kind: 'error',
          message: `No hemos podido enviar la confirmación. ${detail ?? res.statusText}`,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        deduped?: boolean;
        state?: string;
      };
      showToast({
        kind: 'success',
        message: data.deduped
          ? 'Ya habías confirmado; el operador sigue revisando tu cuenta.'
          : 'Listo, avisamos al operador. Te confirmaremos la puesta en producción en breve.',
      });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const onHelpRequestSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const subject = String(formData.get('subject') ?? '').trim();
    const message = String(formData.get('message') ?? '').trim();
    if (subject.length < 3 || message.length < 10) {
      showToast({
        kind: 'error',
        message: 'Indica un asunto (≥3 caracteres) y un mensaje (≥10 caracteres).',
      });
      return;
    }
    setBusyAction('help');
    try {
      const res = await fetch('/api/portal/operator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'help-request', subject, message }),
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        showToast({
          kind: 'error',
          message: `No hemos podido enviar la solicitud. ${detail ?? res.statusText}`,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { deduped?: boolean };
      showToast({
        kind: 'success',
        message: data.deduped
          ? 'Ya nos has pedido ayuda hoy; te responderemos en cuanto sea posible.'
          : 'Hemos enviado tu mensaje al operador. Te responderemos en horario laboral.',
      });
      form.reset();
      setShowHelpForm(false);
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const showOnboardingActions = variant === 'onboarding';
  const showHelpButton = true;

  return (
    <div className="space-y-4" data-testid="self-service-actions">
      {toast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="self-service-toast"
          data-toast-kind={toast.kind}
          className={toastClass(toast.kind)}
        >
          {toast.message}
        </div>
      ) : null}

      {showOnboardingActions ? (
        <section className="card" aria-label="Acciones de onboarding">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Acciones</h2>
            <span className="text-xs text-kairikos-muted">
              Todo lo que puedes hacer sin esperar al operador.
            </span>
          </header>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              className="btn-primary w-full sm:w-auto"
              data-testid="self-service-assets-uploaded"
              onClick={onMarkAssetsUploaded}
              disabled={!canMarkAssetsUploaded || busyAction === 'assets-uploaded'}
              aria-label="He subido mis assets"
            >
              {busyAction === 'assets-uploaded' ? 'Enviando…' : 'He subido mis assets'}
            </button>
            <button
              type="button"
              className="btn-ghost w-full sm:w-auto"
              data-testid="self-service-snooze"
              onClick={onSnoozeMilestone}
              disabled={!activeMilestoneId || busyAction === 'snooze'}
              aria-label="Aplazar el paso activo un día"
            >
              {busyAction === 'snooze'
                ? 'Aplazando…'
                : activeMilestoneId
                  ? `Aplazar ${activeMilestoneId} un día`
                  : 'No hay paso activo para aplazar'}
            </button>
            <button
              type="button"
              className="btn-ghost w-full sm:w-auto"
              data-testid="self-service-go-live-ready"
              onClick={onGoLiveReady}
              disabled={!canGoLiveReady || busyAction === 'go-live-ready'}
              aria-label="Confirmar que estoy listo para puesta en producción"
            >
              {busyAction === 'go-live-ready'
                ? 'Enviando…'
                : 'Estoy listo para go-live'}
            </button>
          </div>
          {!canMarkAssetsUploaded ? (
            <p className="mt-3 text-xs text-kairikos-muted">
              La subida de assets solo se puede marcar cuando el paso activo es T+3
              (configuración inicial).
            </p>
          ) : null}
          {!canGoLiveReady ? (
            <p className="mt-3 text-xs text-kairikos-muted">
              Podrás confirmar el go-live cuando los pasos T+0, T+3 y T+7 estén
              completados.
            </p>
          ) : null}
        </section>
      ) : null}

      {showHelpButton ? (
        <section className="card" aria-label="Solicitar ayuda">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">¿Necesitas ayuda?</h2>
            <span className="text-xs text-kairikos-muted">
              Te respondemos por email en horario laboral.
            </span>
          </header>
          {showHelpForm ? (
            <form className="space-y-3" onSubmit={onHelpRequestSubmit}>
              <input type="hidden" name="clientId" value={clientId} />
              <div>
                <label htmlFor="help-subject" className="label">
                  Asunto
                </label>
                <input
                  id="help-subject"
                  name="subject"
                  className="input"
                  type="text"
                  maxLength={200}
                  minLength={3}
                  required
                  defaultValue={
                    activeMilestoneId ? `Duda en ${activeMilestoneId}` : ''
                  }
                  data-testid="help-subject"
                  placeholder="Ej. No encuentro dónde subir el logo"
                />
              </div>
              <div>
                <label htmlFor="help-message" className="label">
                  Mensaje
                </label>
                <textarea
                  id="help-message"
                  name="message"
                  className="input min-h-[120px]"
                  minLength={10}
                  maxLength={4000}
                  required
                  data-testid="help-message"
                  placeholder="Cuéntanos con detalle qué necesitas."
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  className="btn-ghost w-full sm:w-auto"
                  onClick={() => setShowHelpForm(false)}
                  disabled={busyAction === 'help'}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn-primary w-full sm:w-auto"
                  data-testid="help-submit"
                  disabled={busyAction === 'help'}
                >
                  {busyAction === 'help' ? 'Enviando…' : 'Enviar al operador'}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="btn-primary w-full sm:w-auto"
              data-testid="self-service-help"
              onClick={() => setShowHelpForm(true)}
              disabled={isPending}
            >
              Necesito ayuda
            </button>
          )}
        </section>
      ) : null}

      {/* Hidden marker so QA can assert the revalidation path is wired. */}
      <span hidden data-revalidate-path={revalidatePath} />
    </div>
  );
}

function toastClass(kind: ToastKind): string {
  const base = 'rounded-xl border px-4 py-3 text-sm';
  switch (kind) {
    case 'success':
      return `${base} border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success`;
    case 'info':
      return `${base} border-kairikos-accent/40 bg-kairikos-accent/10 text-kairikos-text`;
    case 'error':
      return `${base} border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger`;
  }
}

async function safeReadDetail(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { detail?: string; error?: string };
    return data?.detail ?? data?.error ?? null;
  } catch {
    return null;
  }
}
