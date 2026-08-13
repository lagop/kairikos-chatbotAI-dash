import type { ChatbotStatusSummary, OnboardingStatus } from '@/types/portal';

// WP-23 — extended from 5 to the 8 real ChatbotClient.state values
// (schema.prisma's column comment / ALLOWED_STATES in
// api/admin/portal/clients/[id]/route.ts). This card only ever receives
// 'live' or 'in-progress' today (deriveOnboardingStatus() in
// chatbot-status.ts is deliberately binary for the client-facing view),
// but the type is now shared with the admin listing's finer-grained
// status, so the Record has to cover every member or the compiler
// rejects it.
const STATUS_LABEL: Record<OnboardingStatus, string> = {
  pending: 'Pendiente de configurar',
  'in-progress': 'En configuración',
  'go-live-pending': 'Pidió salir a producción',
  ready: 'Listo, pendiente de aprobar',
  live: 'En producción',
  updating: 'Actualizando',
  paused: 'En pausa',
  cancelled: 'Archivado',
};

const STATUS_PILL: Record<OnboardingStatus, string> = {
  pending: 'pill-muted',
  'in-progress': 'pill-warning',
  'go-live-pending': 'pill-warning',
  ready: 'pill-warning',
  live: 'pill-success',
  updating: 'pill-warning',
  paused: 'pill-warning',
  cancelled: 'pill-muted',
};

const PERCENT = new Intl.NumberFormat('es-ES', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const DATE_FMT_LONG = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

export function ChatbotStatusCard({ summary }: { summary: ChatbotStatusSummary }) {
  return (
    <div className="card" data-testid="status-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Estado del chatbot
          </p>
          <h2 className="mt-1 text-lg font-semibold">Tu bot en directo</h2>
          <p
            className="mt-1 text-sm text-kairikos-muted"
            data-testid="go-live-date"
            data-go-live={summary.goLiveDate ?? ''}
          >
            {summary.goLiveDate
              ? `En producción desde el ${DATE_FMT_LONG.format(new Date(summary.goLiveDate))}`
              : 'Aún no hemos puesto el chatbot en producción.'}
          </p>
        </div>
        <span
          data-testid="status-badge"
          data-status={summary.status}
          className={STATUS_PILL[summary.status]}
          aria-label={`Estado: ${STATUS_LABEL[summary.status]}`}
        >
          {STATUS_LABEL[summary.status]}
        </span>
      </div>

      <dl
        className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3"
        data-testid="last-7-days"
      >
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4">
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">Conversaciones (7 d.)</dt>
          <dd className="mt-1 text-2xl font-semibold" data-testid="conversations-7d">
            {summary.last7Days.conversations}
          </dd>
        </div>
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4">
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">Tasa de fallback</dt>
          <dd className="mt-1 text-2xl font-semibold" data-testid="fallback-rate">
            {PERCENT.format(summary.last7Days.fallbackRate)}
          </dd>
        </div>
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4">
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">Tasa de derivación</dt>
          <dd className="mt-1 text-2xl font-semibold" data-testid="escalation-rate">
            {PERCENT.format(summary.last7Days.escalationRate)}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-kairikos-muted">ID del espacio: {summary.spaceId}</p>
    </div>
  );
}
