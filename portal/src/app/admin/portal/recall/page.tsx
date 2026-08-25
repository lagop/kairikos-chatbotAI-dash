import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { listRecallQueue, isStuck, stuckThresholdDays, type RecallQueueRow } from '@/lib/recall';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Altas de llamadas · Admin',
  description: 'Clientes de recuperación de llamadas que todavía no están activos.',
  alternates: { canonical: '/admin/portal/recall' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-XX — the queue this whole product needs a portal for.
//
// The known failure mode of the 'recall' product is not technical: the
// client pays, gets distracted, never dials the three MMI forwarding
// codes on his handset, and cancels at three weeks saying it did nothing.
// Nothing in the pipeline detects that on its own, because from the
// system's point of view everything is fine — it is simply waiting.
//
// So this page is deliberately about WHO IS WAITING ON WHOM, and the
// stale thresholds differ per state for that reason: a client who hasn't
// signed gets chased the next day, while Meta's own template review queue
// gets four before anyone calls it late.
// =============================================================================

const STATUS_LABEL: Record<string, string> = {
  paid: 'Pagado, sin contrato',
  contract_signed: 'Contrato firmado',
  meta_connected: 'WhatsApp conectado',
  number_assigned: 'Número asignado',
  templates_approved: 'Esperando plantillas de Meta',
  forwarding_pending: 'Esperando el desvío del cliente',
  forwarding_verified: 'Desvío verificado, sin activar',
};

/** Who the next move belongs to. The operator's whole triage question. */
const WAITING_ON: Record<string, string> = {
  paid: 'cliente',
  contract_signed: 'cliente',
  meta_connected: 'cliente',
  number_assigned: 'nosotros',
  templates_approved: 'Meta',
  forwarding_pending: 'cliente',
  forwarding_verified: 'nosotros',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function RecallQueueCard({ row }: { row: RecallQueueRow }) {
  const stuck = isStuck(row.status, row.since);
  const threshold = stuckThresholdDays(row.status);
  return (
    <li className="card space-y-3" data-testid="recall-queue-row" data-status={row.status} data-stuck={String(stuck)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">{row.clientEmail}</p>
          <h3 className="mt-1 text-base font-semibold">{row.clientName}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={stuck ? 'pill-warning' : 'pill-muted'}>
            {STATUS_LABEL[row.status] ?? row.status}
          </span>
          {stuck ? (
            <span className="pill-danger" data-testid="recall-queue-stuck-badge">
              Parado hace {daysSince(row.since)} días
            </span>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-kairikos-muted">
        Esperando a <span className="font-medium text-kairikos-text">{WAITING_ON[row.status] ?? '—'}</span>
        {threshold !== null ? ` · se marca como parado a los ${threshold} ${threshold === 1 ? 'día' : 'días'}` : ''}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kairikos-border pt-3 text-xs text-kairikos-muted">
        <span>
          {row.e164 ? `Número ${row.e164}` : 'Sin número asignado'}
          {row.hasGreeting ? ' · locución grabada' : ' · sin locución'}
          {` · desde el ${DATE_FORMAT.format(row.since)}`}
        </span>
        <Link
          href={`/admin/portal/${row.clientId}?product=recall`}
          className="underline hover:text-kairikos-text"
          data-testid="recall-queue-view-client"
        >
          Ver cliente →
        </Link>
      </div>
    </li>
  );
}

export default async function AdminRecallQueuePage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/recall');
  }

  let rows: RecallQueueRow[] = [];
  if (isDatabaseConfigured) {
    rows = await listRecallQueue(prisma);
  }

  // Sorted so the ones needing a call today come first; the query already
  // returns oldest-first within that. Done here rather than in SQL because
  // "stuck" is a per-state threshold, not a single date comparison.
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
        title="Altas de recuperación de llamadas"
        description="Clientes que ya pagan pero cuyo servicio todavía no contesta llamadas."
        actions={
          stuckCount > 0 ? (
            <span className="pill-danger" data-testid="recall-queue-stuck-count">
              {stuckCount} {stuckCount === 1 ? 'parado' : 'parados'}
            </span>
          ) : undefined
        }
      />

      {!isDatabaseConfigured ? (
        <EmptyState title="Modo de demostración" description="Esta vista necesita una base de datos configurada." />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="Ningún alta en curso"
          description="Cuando un cliente contrate el producto, su alta aparecerá aquí hasta que el servicio esté activo."
        />
      ) : (
        <ul className="space-y-4" data-testid="recall-queue-list">
          {sorted.map((row) => (
            <RecallQueueCard key={row.subscriptionId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
