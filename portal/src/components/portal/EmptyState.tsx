import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div
        aria-hidden
        className="grid h-12 w-12 place-items-center rounded-full border border-kairikos-border bg-kairikos-surface2 text-kairikos-muted"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <p className="text-base font-semibold">{title}</p>
        {description ? <p className="mt-1 max-w-md text-sm text-kairikos-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
