'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TIER_LABEL } from '@/lib/billing-tier';

export interface OperatorEditorInitial {
  companyName: string | null;
  email: string;
  tier: 'starter' | 'pro' | 'premium' | string;
  state: 'pending' | 'in-progress' | 'live' | 'paused' | 'cancelled' | string;
  goLiveAt: string | null;
  notes: string | null;
}

export interface OperatorEditorProps {
  clientId: string;
  initial: OperatorEditorInitial;
}

type ToastKind = 'success' | 'info' | 'error';

interface ToastState {
  kind: ToastKind;
  message: string;
}

type FieldKey = 'companyName' | 'email' | 'tier' | 'state' | 'goLiveAt' | 'notes';

const TIER_OPTIONS = [
  { value: 'starter', label: 'Web Starter' },
  { value: 'pro', label: 'Web Pro' },
  { value: 'premium', label: 'Web Premium' },
] as const;

const STATE_OPTIONS = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'in-progress', label: 'En curso' },
  { value: 'live', label: 'En producción' },
  { value: 'paused', label: 'En pausa' },
  { value: 'cancelled', label: 'Cancelado' },
] as const;

type PendingConfirm =
  | { field: 'email'; nextValue: string }
  | { field: 'tier'; nextValue: 'starter' | 'pro' | 'premium' };

export function OperatorEditor({ clientId, initial }: OperatorEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [busyField, setBusyField] = useState<FieldKey | null>(null);

  // Local form state. Initializes from `initial` and tracks in-progress edits.
  const [companyName, setCompanyName] = useState<string>(initial.companyName ?? '');
  const [email, setEmail] = useState<string>(initial.email);
  const [tier, setTier] = useState<string>(initial.tier);
  const [state, setState] = useState<string>(initial.state);
  const [goLiveAtLocal, setGoLiveAtLocal] = useState<string>(
    initial.goLiveAt ? initial.goLiveAt.slice(0, 10) : '',
  );
  const [notes, setNotes] = useState<string>(initial.notes ?? '');

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 4500);
  };

  const refresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  async function sendPatch(
    field: FieldKey,
    body: Record<string, unknown>,
    successMessage: string,
  ): Promise<void> {
    setBusyField(field);
    try {
      const res = await fetch(`/api/admin/portal/clients/${encodeURIComponent(clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        showToast({
          kind: 'error',
          message: `No hemos podido guardar ${field}. ${detail ?? res.statusText}`,
        });
        return;
      }
      showToast({ kind: 'success', message: successMessage });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red al guardar ${field}: ${
          err instanceof Error ? err.message : 'desconocido'
        }`,
      });
    } finally {
      setBusyField(null);
    }
  }

  const onSubmitCompanyName = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const next = companyName.trim();
    if (next === (initial.companyName ?? '')) {
      showToast({ kind: 'info', message: 'El nombre de empresa ya está actualizado.' });
      return;
    }
    void sendPatch('companyName', { companyName: next || null }, 'Nombre de empresa guardado.');
  };

  const onSubmitEmail = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const next = email.trim().toLowerCase();
    if (next === initial.email) {
      showToast({ kind: 'info', message: 'El email ya está actualizado.' });
      return;
    }
    setPendingConfirm({ field: 'email', nextValue: next });
  };

  const onSubmitTier = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (tier === initial.tier) {
      showToast({ kind: 'info', message: 'El plan ya está actualizado.' });
      return;
    }
    setPendingConfirm({ field: 'tier', nextValue: tier as 'starter' | 'pro' | 'premium' });
  };

  const onSubmitState = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (state === initial.state) {
      showToast({ kind: 'info', message: 'El estado ya está actualizado.' });
      return;
    }
    void sendPatch('state', { state }, 'Estado del cliente actualizado.');
  };

  const onSubmitGoLiveAt = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const currentDate = initial.goLiveAt ? initial.goLiveAt.slice(0, 10) : '';
    if (goLiveAtLocal === currentDate) {
      showToast({ kind: 'info', message: 'La fecha de go-live ya está actualizada.' });
      return;
    }
    const payload: Record<string, unknown> = goLiveAtLocal
      ? { goLiveAt: new Date(`${goLiveAtLocal}T09:00:00.000Z`).toISOString() }
      : { goLiveAt: null };
    void sendPatch('goLiveAt', payload, 'Fecha de go-live actualizada.');
  };

  const onSubmitNotes = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const next = notes;
    if (next === (initial.notes ?? '')) {
      showToast({ kind: 'info', message: 'Las notas ya están actualizadas.' });
      return;
    }
    void sendPatch('notes', { notes: next || null }, 'Notas internas guardadas.');
  };

  const cancelConfirm = () => {
    if (pendingConfirm?.field === 'email') {
      setEmail(initial.email);
    } else if (pendingConfirm?.field === 'tier') {
      setTier(initial.tier);
    }
    setPendingConfirm(null);
  };

  const onConfirmPending = async () => {
    if (!pendingConfirm) return;
    const confirm = pendingConfirm;
    setPendingConfirm(null);
    if (confirm.field === 'email') {
      await sendPatch(
        'email',
        { email: confirm.nextValue },
        'Email enviado al nuevo contacto.',
      );
    } else if (confirm.field === 'tier') {
      await sendPatch(
        'tier',
        { tier: confirm.nextValue },
        `Plan actualizado a ${TIER_LABEL[confirm.nextValue]}.`,
      );
    }
  };

  return (
    <section
      className="card"
      aria-label="Editar datos del cliente"
      data-testid="operator-editor"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Editar</h2>
        <span className="text-xs text-kairikos-muted">
          Cada campo se guarda de forma independiente con su botón Guardar.
        </span>
      </header>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="operator-editor-toast"
          data-toast-kind={toast.kind}
          className={toastClass(toast.kind)}
        >
          {toast.message}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <form onSubmit={onSubmitCompanyName} className="space-y-2" data-testid="operator-edit-form-companyName">
          <label htmlFor="operator-edit-companyName" className="label">
            Nombre de empresa
          </label>
          <input
            id="operator-edit-companyName"
            name="companyName"
            type="text"
            className="input"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            maxLength={200}
            data-testid="operator-edit-companyName"
            placeholder="Nombre comercial del cliente"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-companyName-save"
              disabled={busyField === 'companyName' || isPending}
            >
              {busyField === 'companyName' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>

        <form onSubmit={onSubmitEmail} className="space-y-2" data-testid="operator-edit-form-email">
          <label htmlFor="operator-edit-email" className="label">
            Email de contacto
          </label>
          <input
            id="operator-edit-email"
            name="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="operator-edit-email"
            placeholder="cliente@empresa.com"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-email-save"
              disabled={busyField === 'email' || isPending}
            >
              {busyField === 'email' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>

        <form onSubmit={onSubmitTier} className="space-y-2" data-testid="operator-edit-form-tier">
          <label htmlFor="operator-edit-tier" className="label">
            Plan
          </label>
          <select
            id="operator-edit-tier"
            name="tier"
            className="input"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            data-testid="operator-edit-tier"
          >
            {TIER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-tier-save"
              disabled={busyField === 'tier' || isPending}
            >
              {busyField === 'tier' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>

        <form onSubmit={onSubmitState} className="space-y-2" data-testid="operator-edit-form-state">
          <label htmlFor="operator-edit-state" className="label">
            Estado del onboarding
          </label>
          <select
            id="operator-edit-state"
            name="state"
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value)}
            data-testid="operator-edit-state"
          >
            {STATE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-state-save"
              disabled={busyField === 'state' || isPending}
            >
              {busyField === 'state' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>

        <form onSubmit={onSubmitGoLiveAt} className="space-y-2" data-testid="operator-edit-form-goLiveAt">
          <label htmlFor="operator-edit-goLiveAt" className="label">
            Fecha de go-live
          </label>
          <input
            id="operator-edit-goLiveAt"
            name="goLiveAt"
            type="date"
            className="input"
            value={goLiveAtLocal}
            onChange={(e) => setGoLiveAtLocal(e.target.value)}
            data-testid="operator-edit-goLiveAt"
          />
          <p className="text-xs text-kairikos-muted">
            Déjalo vacío para retirar la fecha de go-live del cliente.
          </p>
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-goLiveAt-save"
              disabled={busyField === 'goLiveAt' || isPending}
            >
              {busyField === 'goLiveAt' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>

        <form onSubmit={onSubmitNotes} className="space-y-2 md:col-span-2" data-testid="operator-edit-form-notes">
          <label htmlFor="operator-edit-notes" className="label">
            Notas internas
          </label>
          <textarea
            id="operator-edit-notes"
            name="notes"
            className="input min-h-[120px]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4000}
            data-testid="operator-edit-notes"
            placeholder="Anotaciones del operador (no las ve el cliente)."
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              data-testid="operator-edit-notes-save"
              disabled={busyField === 'notes' || isPending}
            >
              {busyField === 'notes' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>

      {pendingConfirm ? (
        <ConfirmModal
          field={pendingConfirm.field}
          onCancel={cancelConfirm}
          onConfirm={onConfirmPending}
          busy={busyField !== null}
        />
      ) : null}
    </section>
  );
}

function ConfirmModal({
  field,
  onCancel,
  onConfirm,
  busy,
}: {
  field: 'email' | 'tier';
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const title = field === 'email' ? 'Cambiar email de contacto' : 'Cambiar plan del cliente';
  const description =
    field === 'email'
      ? 'Esto invalidará el acceso del usuario actual. El nuevo contacto recibirá un email para crear contraseña antes de poder entrar al portal.'
      : 'Cambiar el plan no factura automáticamente. La facturación se actualizará en el siguiente ciclo de Stripe.';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="operator-confirm-title"
      aria-describedby="operator-confirm-desc"
      data-testid={`operator-confirm-modal-${field}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-kairikos-bg/80 p-4"
    >
      <div className="card w-full max-w-md">
        <h3 id="operator-confirm-title" className="text-lg font-semibold">
          {title}
        </h3>
        <p id="operator-confirm-desc" className="mt-2 text-sm text-kairikos-muted">
          {description}
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn-ghost"
            data-testid={`operator-confirm-${field}-cancel`}
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid={`operator-confirm-${field}-confirm`}
            onClick={onConfirm}
            disabled={busy}
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}

function toastClass(kind: ToastKind): string {
  const base = 'mb-4 rounded-xl border px-4 py-3 text-sm';
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
