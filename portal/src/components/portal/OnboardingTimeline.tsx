import type { OnboardingTimelineRow } from '@/types/portal';

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const STEP_LABEL: Record<OnboardingTimelineRow['step'], string> = {
  t_plus_0: 'T+0',
  t_plus_3: 'T+3',
  t_plus_7: 'T+7',
  t_plus_14: 'T+14',
};

export function OnboardingTimeline({ rows }: { rows: OnboardingTimelineRow[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-kairikos-muted">
        Aún no hay pasos registrados. Te avisaremos por email cuando se complete el primero.
      </p>
    );
  }
  return (
    <ol
      data-testid="onboarding-timeline"
      className="relative space-y-5 border-l border-kairikos-border pl-5"
    >
      {rows.map((row) => {
        const isDone = row.status === 'done';
        const isCurrent = row.status === 'current';
        const dotClass = isDone
          ? 'bg-kairikos-success'
          : isCurrent
            ? 'bg-kairikos-accent ring-4 ring-kairikos-accent/30'
            : 'bg-kairikos-border';
        return (
          <li
            key={row.id}
            data-testid="timeline-item"
            data-status={row.status}
            data-step={row.step}
            className="relative"
          >
            <span
              aria-hidden
              className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ${dotClass}`}
            />
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill-muted">{STEP_LABEL[row.step]}</span>
                <h3 className="text-sm font-semibold">{row.label}</h3>
                {isCurrent ? (
                  <span className="pill-warning" aria-label="Paso en curso">
                    En curso
                  </span>
                ) : null}
                {isDone ? (
                  <span className="pill-success" aria-label="Paso completado">
                    Completado
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-kairikos-muted">{row.description}</p>
              <p
                className="text-xs text-kairikos-muted"
                data-occurred-at={row.occurredAt ?? ''}
              >
                {row.occurredAt
                  ? `Realizado el ${DATE_FORMAT.format(new Date(row.occurredAt))}`
                  : 'Pendiente de realización'}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
