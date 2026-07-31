'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { WIZARD_STEPS, useOnboarding, type WizardStep } from '@/lib/onboarding/self-serve-context';

const STEP_LABEL: Record<WizardStep, string> = {
  signup: 'Registro',
  product: 'Producto',
  config: 'Configuración',
  pago: 'Pago',
  activado: 'Activación',
};

interface OnboardingStepperProps {
  current: WizardStep;
}

export function OnboardingStepper({ current }: OnboardingStepperProps) {
  const { state, hasReachedStep } = useOnboarding();
  const currentIndex = useMemo(() => WIZARD_STEPS.indexOf(current), [current]);

  return (
    <ol
      aria-label="Pasos del wizard de activación"
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      {WIZARD_STEPS.map((step, index) => {
        const isDone = !!state.stepCompletedAt[step];
        const isCurrent = index === currentIndex;
        const isReachable = hasReachedStep(step);
        const dotClass = isDone
          ? 'bg-kairikos-success text-kairikos-success'
          : isCurrent
            ? 'bg-kairikos-accent text-kairikos-accent ring-4 ring-kairikos-accent/30'
            : 'bg-kairikos-border text-kairikos-border';
        const labelClass = isCurrent
          ? 'text-kairikos-text font-semibold'
          : isDone
            ? 'text-kairikos-success'
            : 'text-kairikos-muted';

        const inner = (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
            <span className="text-[11px] uppercase tracking-wide">{index + 1}</span>
            <span className={labelClass}>{STEP_LABEL[step]}</span>
          </span>
        );

        if (!isReachable) {
          return (
            <li
              key={step}
              className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1.5"
              aria-disabled
            >
              {inner}
            </li>
          );
        }
        return (
          <li key={step} className="rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1.5">
            <Link
              href={`/onboarding/${step}`}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-kairikos-accent"
            >
              {inner}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
