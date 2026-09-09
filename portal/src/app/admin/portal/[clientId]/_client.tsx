'use client';

// WP-07 — extracted from page.tsx (a Server Component) into its own Client
// Component so the milestone buttons can ask for explicit confirmation
// before submitting. Previously these were one-click, no-confirmation forms
// sitting directly below copy that told the operator the page couldn't
// modify anything — exactly backwards for the one part of the page that
// actually writes to a client's onboarding timeline in production.

import type { MouseEvent } from 'react';
import type { OnboardingTimelineRow } from '@/types/portal';
import { ALLOWED_MILESTONES, MILESTONE_LABEL, MILESTONE_TO_DB } from './onboarding-constants';

export function OnboardingOperatorControls({
  clientId,
  productCode,
  timeline,
  advance,
}: {
  clientId: string;
  productCode: string;
  timeline: OnboardingTimelineRow[];
  advance: (formData: FormData) => Promise<void>;
}) {
  const doneSteps = new Set(
    timeline.filter((row) => row.status === 'done').map((row) => row.step),
  );
  const pendingMilestones = ALLOWED_MILESTONES.filter((m) => {
    const dbMilestone = MILESTONE_TO_DB[m];
    return !doneSteps.has(dbMilestone);
  });
  const firstPending = pendingMilestones[0];

  const confirmOrCancel = (message: string) => (e: MouseEvent<HTMLButtonElement>) => {
    if (!window.confirm(message)) {
      e.preventDefault();
    }
  };

  return (
    <div
      className="mt-5 border-t border-kairikos-border pt-4"
      data-testid="onboarding-operator-controls"
    >
      <p className="mb-3 text-sm text-kairikos-muted">
        Como operador, puedes registrar los hitos del onboarding para que el
        cliente los vea activados en su portal. Esta acción escribe
        directamente en la línea de tiempo del cliente.
      </p>
      {timeline.length === 0 ? (
        firstPending ? (
          <form action={advance}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="productCode" value={productCode} />
            <input type="hidden" name="milestone" value={firstPending} />
            <button
              type="submit"
              className="btn-primary"
              data-testid="onboarding-operator-start"
              data-milestone={firstPending}
              onClick={confirmOrCancel(
                `¿Iniciar el onboarding de este cliente en ${firstPending} (${MILESTONE_LABEL[firstPending]})? ` +
                  'Esto escribe en producción: el cliente lo verá activado en su portal de inmediato.',
              )}
            >
              Iniciar onboarding ({firstPending} · {MILESTONE_LABEL[firstPending]})
            </button>
          </form>
        ) : null
      ) : (
        <ul className="flex flex-col gap-2">
          {ALLOWED_MILESTONES.map((m) => {
            const dbMilestone = MILESTONE_TO_DB[m];
            const isDone = doneSteps.has(dbMilestone);
            return (
              <li
                key={m}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
                data-testid="onboarding-operator-row"
                data-milestone={m}
                data-done={isDone ? 'true' : 'false'}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">
                    {m} · {MILESTONE_LABEL[m]}
                  </span>
                  <span className="text-xs text-kairikos-muted">
                    {isDone
                      ? 'Marcado como completado.'
                      : 'Pendiente de registrar.'}
                  </span>
                </div>
                {isDone ? (
                  <span className="pill-success" data-testid="onboarding-operator-done-pill">
                    Completado
                  </span>
                ) : (
                  <form action={advance}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <input type="hidden" name="productCode" value={productCode} />
                    <input type="hidden" name="milestone" value={m} />
                    <button
                      type="submit"
                      className="btn-ghost"
                      data-testid="onboarding-operator-mark"
                      data-milestone={m}
                      onClick={confirmOrCancel(
                        `¿Marcar ${m} (${MILESTONE_LABEL[m]}) como completado? ` +
                          'El cliente verá este hito activado en su portal de inmediato.',
                      )}
                    >
                      Marcar como completado
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
