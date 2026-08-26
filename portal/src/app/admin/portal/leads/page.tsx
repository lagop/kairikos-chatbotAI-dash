import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { listLeadsQueue, isStuck, stuckThresholdDays, type LeadQueueRow } from '@/lib/leads';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Leads sin cerrar · Admin',
  description: 'Clientes cuyo equipo de ventas ha dejado leads sin contactar o sin cerrar.',
  alternates: { canonical: '/admin/portal/leads' },
  robots: { index: false, follow: false },
};

// =============================================================================
// Leads Fase 6 — the cross-client queue Fase 5 deliberately deferred (see
// LeadsSummaryPanel.tsx and leads.ts's stuck-detection header comment).
//
// The failure mode this closes: a lead sitting untouched looks exactly
// like a healthy one to the system — nothing crashes, nothing errors, the
// client just stopped opening /portal/leads. Same "who is waiting on
// whom" framing as /admin/portal/recall, simplified: both open statuses
// here are always waiting on the CLIENT's own sales team, never on us or
// a third party, so there is no WAITING_ON map to speak of.
// =============================================================================

const STATUS_LABEL: Record<string, string> = {
  nuevo: 'Sin contactar',
  contactado: 'Contactado, sin cerrar',
};

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
  web: 'Web',
  phone: 'Llamada',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function LeadQueueCard({ row }: { row: LeadQueueRow }) {
  const stuck = isStuck(row.status, row.since);
  const threshold = stuckThresholdDays(row.status);
  const contactParts = [row.contactName, row.contactPhone, row.contactEmail].filter(Boolean);
  return (
    <li className="card space-y-3" data-testid="leads-queue-row" data-status={row.status} data-stuck={String(stuck)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">{row.clientEmail}</p>
          <h3 className="mt-1 text-base font-semibold">{row.clientName}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={stuck ? 'pill-warning' : 'pill-muted'}>{STATUS_LABEL[row.status] ?? row.status}</span>
          {stuck ? (
            <span className="pill-danger" data-testid="leads-queue-stuck-badge">
              Parado hace {daysSince(row.since)} días
            </span>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-kairikos-text">
        {contactParts.length > 0 ? contactParts.join(' · ') : 'Sin datos de contacto'}
        {row.score !== null ? ` · prioridad ${row.score}` : ''}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kairikos-border pt-3 text-xs text-kairikos-muted">
        <span>
          {row.channel ? CHANNEL_LABEL[row.channel] ?? row.channel : 'Canal desconocido'}
          {threshold !== null ? ` · se marca como parado a los ${threshold} ${threshold === 1 ? 'día' : 'días'}` : ''}
          {` · desde el ${DATE_FORMAT.format(row.since)}`}
        </span>
        <Link
          href={`/admin/portal/${row.clientId}?product=leads`}
          className="underline hover:text-kairikos-text"
          data-testid="leads-queue-view-client"
        >
          Ver cliente →
        </Link>
      </div>
    </li>
  );
}

export default async function AdminLeadsQueuePage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/leads');
  }

  let rows: LeadQueueRow[] = [];
  if (isDatabaseConfigured) {
    rows = await listLeadsQueue(prisma);
  }

  // Same sort as /admin/portal/recall: stuck ones first, oldest-within-
  // that after. Done here rather than in SQL because "stuck" is a
  // per-status threshold, not a single date comparison.
  const sorted = [...rows].sort((a, b) => {
    const aStuck = isStuck(a.status, a.since);
    const bStuck = isStuck(b.status, b.since);
    if (aStuck !== bStuck) return aStuck ? -1 : 1;
    return a.since.getTime() - b.since.getTime();
  });
  const stuckCount = sorted.filter((row) => isStuck(row.status, row.since)).length;

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/clients" className="hover:text-kairikos-text">← Volver al listado</Link>
      </div>
      <PageHeading
        eyebrow="Operador"
        title="Leads sin cerrar"
        description="Leads capturados por la IA que el equipo del cliente todavía no ha contactado o no ha cerrado."
        actions={
          stuckCount > 0 ? (
            <span className="pill-danger" data-testid="leads-queue-stuck-count">
              {stuckCount} {stuckCount === 1 ? 'parado' : 'parados'}
            </span>
          ) : undefined
        }
      />

      {!isDatabaseConfigured ? (
        <EmptyState title="Modo de demostración" description="Esta vista necesita una base de datos configurada." />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="Ningún lead abierto"
          description="En cuanto la IA capture un lead, se queda aquí hasta que el equipo del cliente lo cierre (convertido o descartado)."
        />
      ) : (
        <ul className="space-y-4" data-testid="leads-queue-list">
          {sorted.map((row) => (
            <LeadQueueCard key={row.leadId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
