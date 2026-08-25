import Link from 'next/link';

// =============================================================================
// WP-XX — read-only operator view of one client's 'recall' subscription.
//
// Read-only on purpose in this phase: the actions that move the state
// machine (assign a number, mark forwarding verified, activate) each bind
// or release a real resource, so they arrive with their own routes and
// their own audit rows rather than as buttons bolted onto a summary.
//
// What this DOES have to do well is answer the two questions an operator
// actually asks: "where is this client stuck, and for how long" — which
// is the whole reason the product needs a portal at all — and "what did
// the last caller actually say", which is what turns a support call into
// a thirty-second answer.
// =============================================================================

export interface RecallCallRow {
  id: string;
  startedAt: string;
  fromNumber: string | null;
  withheld: boolean;
  outcome: string;
  transcript: string | null;
  recordingDurationSeconds: number | null;
  leadId: string | null;
}

export interface RecallPanelData {
  subscriptionId: string;
  status: string;
  since: string;
  stuck: boolean;
  stuckThresholdDays: number | null;
  e164: string | null;
  hasGreeting: boolean;
  ownerWhatsapp: string | null;
  calls: RecallCallRow[];
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Pagado',
  contract_signed: 'Contrato firmado',
  meta_connected: 'WhatsApp conectado',
  number_assigned: 'Número asignado',
  templates_approved: 'Plantillas aprobadas',
  forwarding_pending: 'Esperando el desvío',
  forwarding_verified: 'Desvío verificado',
  active: 'Activo',
  paused: 'Pausado',
  cancelled: 'Cancelado',
};

const STATUS_PILL: Record<string, string> = {
  active: 'pill-success',
  paused: 'pill-warning',
  cancelled: 'pill-muted',
};

const OUTCOME_LABEL: Record<string, string> = {
  pending: 'En curso',
  recorded: 'Con recado',
  no_message: 'Sin recado',
  withheld: 'Número oculto',
  blocked: 'Bloqueado',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

export function RecallOperatorPanel({ data }: { data: RecallPanelData | null }) {
  if (!data) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="recall-panel-empty">
        Este cliente tiene el producto contratado pero todavía no tiene una suscripción de recuperación de llamadas
        creada.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="recall-operator-panel" data-status={data.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={STATUS_PILL[data.status] ?? 'pill-warning'}>
          {STATUS_LABEL[data.status] ?? data.status}
        </span>
        {data.stuck ? (
          <span className="pill-danger" data-testid="recall-stuck-badge">
            Atascado hace {daysSince(data.since)} días
          </span>
        ) : null}
        <span className="text-xs text-kairikos-muted">
          Desde el {DATE_FORMAT.format(new Date(data.since))}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">Número de desvío</dt>
          <dd className="mt-1 text-sm font-medium" data-testid="recall-panel-number">
            {data.e164 ?? <span className="text-kairikos-muted">Sin asignar</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">Locución</dt>
          <dd className="mt-1 text-sm font-medium">
            {data.hasGreeting ? 'Grabada' : <span className="text-kairikos-muted">Pendiente</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-kairikos-muted">WhatsApp del dueño</dt>
          <dd className="mt-1 text-sm font-medium">
            {data.ownerWhatsapp ?? <span className="text-kairikos-muted">Sin configurar</span>}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Últimas llamadas</h3>
        {data.calls.length === 0 ? (
          <p className="text-sm text-kairikos-muted" data-testid="recall-panel-no-calls">
            Todavía no ha entrado ninguna llamada.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="recall-call-list">
            {data.calls.map((call) => (
              <li
                key={call.id}
                className="rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
                data-testid="recall-call-row"
                data-outcome={call.outcome}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {call.withheld ? 'Número oculto' : (call.fromNumber ?? 'Desconocido')}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-kairikos-muted">
                    <span>{OUTCOME_LABEL[call.outcome] ?? call.outcome}</span>
                    <span>{DATE_FORMAT.format(new Date(call.startedAt))}</span>
                  </span>
                </div>
                {call.transcript ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-kairikos-text" data-testid="recall-call-transcript">
                    {call.transcript}
                  </p>
                ) : call.outcome === 'recorded' ? (
                  <p className="mt-1 text-xs text-kairikos-muted">Transcripción pendiente.</p>
                ) : null}
                {call.leadId ? (
                  <Link
                    href="/portal/leads"
                    className="mt-1 inline-block text-xs text-kairikos-accent2 hover:underline"
                    data-testid="recall-call-lead-link"
                  >
                    Generó un lead →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
