export type WizardBlock = 'identidad' | 'comportamiento' | 'activacion';

export interface WizardBlockProgressStep {
  number: number;
  key: string;
  label: string;
  visible: boolean;
  autoConfigured: boolean;
  v11Deferred: boolean;
}

const BLOCK_META: Record<WizardBlock, { label: string; shortLabel: string; description: string }> = {
  identidad: {
    label: 'Identidad del negocio',
    shortLabel: 'Identidad',
    description: 'Quién eres y qué ofreces',
  },
  comportamiento: {
    label: 'Comportamiento del chatbot',
    shortLabel: 'Comportamiento',
    description: 'Cómo responde y actúa tu bot',
  },
  activacion: {
    label: 'Activación y pruebas',
    shortLabel: 'Activación',
    description: 'Puesta a punto antes del lanzamiento',
  },
};

const BLOCK_STEPS: Record<WizardBlock, Set<number>> = {
  identidad: new Set([1, 2, 3, 4]),
  comportamiento: new Set([5, 6, 7, 8, 9]),
  activacion: new Set([10, 11]),
};

function getBlockForStep(stepNumber: number): WizardBlock | null {
  for (const [block, steps] of Object.entries(BLOCK_STEPS)) {
    if (steps.has(stepNumber)) return block as WizardBlock;
  }
  return null;
}

export function WizardBlockProgress({
  steps,
  currentStepNumber,
}: {
  steps: WizardBlockProgressStep[];
  currentStepNumber: number;
}) {
  const currentBlock = getBlockForStep(currentStepNumber);

  const blocks = (Object.keys(BLOCK_META) as WizardBlock[]).map((block) => {
    const blockSteps = steps.filter((s) => BLOCK_STEPS[block].has(s.number) && !s.v11Deferred);
    const completedCount = blockSteps.filter(
      (s) => !s.autoConfigured && s.visible,
    ).length;
    const visibleCount = blockSteps.filter((s) => s.visible).length;
    const isCurrent = currentBlock === block;
    const allDone = visibleCount > 0 && completedCount >= visibleCount;

    return {
      block,
      meta: BLOCK_META[block],
      steps: blockSteps,
      completedCount,
      visibleCount,
      isCurrent,
      allDone,
    };
  });

  return (
    <nav aria-label="Progreso de configuración" className="card">
      <ol className="flex flex-col gap-4 sm:flex-row sm:gap-0">
        {blocks.map((b, idx) => (
          <li key={b.block} className="flex-1">
            <div className="flex items-start gap-3 sm:flex-col sm:gap-1.5">
              <span
                aria-hidden
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold sm:mt-0 ${
                  b.allDone
                    ? 'bg-kairikos-success/20 text-kairikos-success'
                    : b.isCurrent
                      ? 'bg-kairikos-accent/20 text-kairikos-accent ring-1 ring-kairikos-accent'
                      : 'bg-kairikos-surface2 text-kairikos-muted'
                }`}
              >
                {b.allDone ? '✓' : idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-semibold ${
                    b.isCurrent ? 'text-kairikos-text' : 'text-kairikos-muted'
                  }`}
                >
                  {b.meta.label}
                </p>
                <p className="text-xs text-kairikos-muted/70">{b.meta.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {b.steps.map((s) => {
                    const isStepCurrent = s.number === currentStepNumber;
                    const isStepDone = !s.autoConfigured && s.visible;
                    return (
                      <span
                        key={s.key}
                        aria-label={`Paso ${s.number}: ${s.label}${isStepDone ? ' (completado)' : ''}`}
                        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                          isStepCurrent
                            ? 'bg-kairikos-accent text-white ring-2 ring-kairikos-accent/50'
                            : isStepDone
                              ? 'bg-kairikos-success/20 text-kairikos-success'
                              : s.visible
                                ? 'bg-kairikos-surface2 text-kairikos-muted'
                                : 'bg-kairikos-border/20 text-kairikos-muted/40'
                        }`}
                      >
                        {isStepDone ? '✓' : s.number}
                      </span>
                    );
                  })}
                </div>
              </div>
              {idx < blocks.length - 1 ? (
                <span
                  aria-hidden
                  className="hidden h-px flex-1 self-center bg-kairikos-border sm:block"
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}
