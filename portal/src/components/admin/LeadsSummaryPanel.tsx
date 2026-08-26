// =============================================================================
// Leads Fase 5 — read-only operator view of one client's leads. Plain
// server-renderable component (no 'use client', no interactivity) —
// unlike ChannelsOperatorPanel, there is no operator-side mutation here:
// the client's own sales team owns the whole status lifecycle (see the
// plan's "Diseño" section on why a cross-client queue was deferred).
// =============================================================================

const STATUS_LABEL: Record<string, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  convertido: 'Convertido',
  descartado: 'Descartado',
};

const STATUS_PILL: Record<string, string> = {
  nuevo: 'pill-warning',
  contactado: 'pill-warning',
  convertido: 'pill-success',
  descartado: 'pill-muted',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface LeadSummaryRow {
  id: string;
  status: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  summary: string | null;
  score: number | null;
  scoreReason: string | null;
  channel: string | null;
  createdAt: Date;
}

export function LeadsSummaryPanel({ leads }: { leads: LeadSummaryRow[] }) {
  if (leads.length === 0) {
    return <p className="text-sm text-kairikos-muted">Este cliente todavía no tiene leads capturados.</p>;
  }

  return (
    <ul className="space-y-2" data-testid="leads-summary-list">
      {leads.map((lead) => {
        const contactParts = [lead.contactName, lead.contactPhone, lead.contactEmail].filter(Boolean);
        return (
          <li key={lead.id} className="rounded-md border border-kairikos-border p-3" data-testid="leads-summary-row" data-status={lead.status}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs uppercase tracking-wider text-kairikos-muted">
                  {DATE_FMT.format(lead.createdAt)}
                  {lead.channel ? ` · ${lead.channel}` : ''}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {contactParts.length > 0 ? contactParts.join(' · ') : 'Sin datos de contacto'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {lead.score !== null ? <span className="pill-muted">Prioridad {lead.score}</span> : null}
                <span className={STATUS_PILL[lead.status] ?? 'pill-muted'}>{STATUS_LABEL[lead.status] ?? lead.status}</span>
              </div>
            </div>
            {lead.summary ? <p className="mt-2 text-sm text-kairikos-text">{lead.summary}</p> : null}
            {lead.scoreReason ? (
              <p className="mt-1 text-xs italic text-kairikos-muted" data-testid="leads-summary-score-reason">
                Por qué esta prioridad: {lead.scoreReason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
