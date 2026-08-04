'use client';

export default function OnboardingStepError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid gap-4 rounded-2xl border border-kairikos-danger/40 bg-kairikos-danger/10 p-4 text-sm">
      <h2 className="text-base font-semibold text-kairikos-danger">
        Error renderizando el paso del wizard
      </h2>
      <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-kairikos-surface2 p-3 text-xs">
        {error?.name ?? 'Error'}: {error?.message ?? 'unknown'}
        {'\n'}digest: {error?.digest ?? 'n/a'}
        {error?.stack ? `\n${error.stack.split('\n').slice(0, 6).join('\n')}` : ''}
      </pre>
      <button type="button" onClick={reset} className="btn-primary w-fit">
        Reintentar
      </button>
    </div>
  );
}