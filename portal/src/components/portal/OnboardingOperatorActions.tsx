'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  startOnboardingAction,
  markMilestoneAction,
  type OnboardingMilestoneId,
} from '@/app/admin/portal/[clientId]/onboarding-actions';

// =============================================================================
// KAIA-14345 / KAIA-14368 — operator-side onboarding advance controls
// rendered inside the admin overview page's Onboarding section.
//
// Two shapes per the QA ticket's acceptance:
//
//   * Empty timeline (no rows in `chatbotActivity`) → a single primary
//     button "Iniciar onboarding (T+0 · Bienvenida y acceso al portal)".
//     Clicking it calls `startOnboardingAction` which upserts the T+0 row.
//   * Timeline with rows OR after the start → four per-step rows
//     (T+0/T+3/T+7/T+14) with `data-testid="onboarding-operator-row"`,
//     a status pill (Completado / En curso / Pendiente), and either
//     `data-done="true"` + "Completado" pill or a "Marcar como
//     completado" button (T+3/T+7/T+14 fall through to the same shape).
//
// After every action the component calls `router.refresh()` so the server
// component re-runs its `prisma.chatbotActivity.findMany` and surfaces
// the new state in the OnboardingTimeline + the operator rows. The
// matching server action also calls `revalidatePath` so a hard reload
// picks up the new state even without `router.refresh()`.
//
// All strings are Spanish by default; "Marcar como completado" /
// "Completado" match the QA ticket exactly.
// =============================================================================

const STEP_LABEL: Record<OnboardingMilestoneId, string> = {
  'T+0': 'T+0 · Bienvenida y acceso al portal',
  'T+3': 'T+3 · Configuración inicial',
  'T+7': 'T+7 · Puesta en producción',
  'T+14': 'T+14 · Revisión y optimización',
};

const STEP_ORDER: ReadonlyArray<OnboardingMilestoneId> = ['T+0', 'T+3', 'T+7', 'T+14'];

export interface OnboardingOperatorActionsProps {
  clientId: string;
  doneMilestones: ReadonlyArray<OnboardingMilestoneId>;
}

type ToastKind = 'success' | 'error';

interface ToastState {
  kind: ToastKind;
  message: string;
}

type BusyKey = 'start' | OnboardingMilestoneId;

function isDone(doneMilestones: ReadonlyArray<OnboardingMilestoneId>, milestone: OnboardingMilestoneId) {
  return doneMilestones.includes(milestone);
}

export function OnboardingOperatorActions({
  clientId,
  doneMilestones,
}: OnboardingOperatorActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState<BusyKey | null>(null);

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 4500);
  };

  const refresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  const handleStart = async () => {
    setBusy('start');
    try {
      const result = await startOnboardingAction({ clientId });
      if (!result.ok) {
        showToast({
          kind: 'error',
          message: `No hemos podido iniciar el onboarding. ${
            result.detail ?? result.error ?? 'error desconocido'
          }`,
        });
        return;
      }
      showToast({
        kind: 'success',
        message: 'Onboarding iniciado. T+0 marcado como completado.',
      });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red al iniciar onboarding: ${
          err instanceof Error ? err.message : 'desconocido'
        }`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleMark = async (milestone: OnboardingMilestoneId) => {
    setBusy(milestone);
    try {
      const result = await markMilestoneAction({ clientId, milestone });
      if (!result.ok) {
        showToast({
          kind: 'error',
          message: `No hemos podido marcar ${milestone} como completado. ${
            result.detail ?? result.error ?? 'error desconocido'
          }`,
        });
        return;
      }
      showToast({
        kind: 'success',
        message: `${milestone} marcado como completado.`,
      });
      refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Error de red al marcar ${milestone}: ${
          err instanceof Error ? err.message : 'desconocido'
        }`,
      });
    } finally {
      setBusy(null);
    }
  };

  const allDone = STEP_ORDER.every((m) => isDone(doneMilestones, m));
  const hasAny = doneMilestones.length > 0;

  return (
    <div
      data-testid="onboarding-operator-actions"
      className="mt-4 space-y-3"
    >
      <p
        className="text-xs text-kairikos-muted"
        data-testid="onboarding-operator-controls-pill"
      >
        Controles de operador activos
      </p>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="onboarding-operator-toast"
          data-toast-kind={toast.kind}
          className={
            toast.kind === 'success'
              ? 'rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success'
              : 'rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger'
          }
        >
          {toast.message}
        </div>
      ) : null}

      {!hasAny ? (
        <button
          type="button"
          className="btn-primary"
          data-testid="onboarding-operator-start"
          onClick={() => void handleStart()}
          disabled={busy === 'start' || isPending}
        >
          {busy === 'start' ? 'Iniciando…' : 'Iniciar onboarding (T+0 · Bienvenida y acceso al portal)'}
        </button>
      ) : null}

      <ol
        className="space-y-2"
        data-testid="onboarding-operator-rows"
      >
        {STEP_ORDER.map((milestone) => {
          const done = isDone(doneMilestones, milestone);
          const isBusy = busy === milestone;
          return (
            <li
              key={milestone}
              data-testid="onboarding-operator-row"
              data-step={milestone}
              data-done={done ? 'true' : 'false'}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-bg/40 px-3 py-2"
            >
              <span className="text-sm font-medium">{STEP_LABEL[milestone]}</span>
              {done ? (
                <span
                  className="pill-success"
                  aria-label="Paso completado"
                  data-testid={`onboarding-operator-row-pill-${milestone}`}
                >
                  Completado
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  data-testid={`onboarding-operator-mark-${milestone}`}
                  onClick={() => void handleMark(milestone)}
                  disabled={isBusy || isPending}
                >
                  {isBusy ? 'Guardando…' : `Marcar como completado (${milestone})`}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {allDone ? (
        <p className="text-xs text-kairikos-success" data-testid="onboarding-operator-all-done">
          Todos los pasos del onboarding están completados.
        </p>
      ) : null}
    </div>
  );
}
