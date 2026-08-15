import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { listWebQuoteQueue, type WebQuoteQueueRow } from '@/lib/web-quotes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Presupuestos de web · Admin',
  description: 'Bandeja de clientes que pidieron presupuesto para el producto de web.',
  alternates: { canonical: '/admin/portal/web-quotes' },
  robots: { index: false, follow: false },
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  sent: 'Enviado',
  accepted: 'Aceptado',
  invoiced: 'Facturado',
  paid: 'Pagado',
  cancelled: 'Cancelado',
};

const STATUS_PILL: Record<string, string> = {
  draft: 'pill-muted',
  sent: 'pill-warning',
  accepted: 'pill-warning',
  invoiced: 'pill-warning',
  paid: 'pill-success',
  cancelled: 'pill-muted',
};

function WebQuoteQueueCard({ row }: { row: WebQuoteQueueRow }) {
  const status = row.webQuote?.status ?? 'sin_presupuesto';
  return (
    <li className="card space-y-3" data-testid="web-quote-queue-row" data-status={status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">{row.clientEmail}</p>
          <h3 className="mt-1 text-base font-semibold">{row.clientName}</h3>
        </div>
        <span className={STATUS_PILL[status] ?? 'pill-muted'}>
          {row.webQuote ? STATUS_LABEL[status] ?? status : 'Sin presupuesto todavía'}
        </span>
      </div>
      {row.webQuote ? (
        <p className="text-sm text-kairikos-text">
          {formatPrice(row.webQuote.amountCents, row.webQuote.currency)} — {row.webQuote.description}
        </p>
      ) : (
        <p className="text-sm text-kairikos-muted">El cliente pidió presupuesto pero todavía no hay uno cargado.</p>
      )}
      <div className="flex items-center justify-between border-t border-kairikos-border pt-3 text-xs text-kairikos-muted">
        <span>
          {row.webQuote?.sentAt ? `Enviado el ${DATE_FORMAT.format(new Date(row.webQuote.sentAt))}` : 'Todavía no enviado'}
        </span>
        <Link href={`/admin/portal/${row.clientId}?product=web`} className="underline hover:text-kairikos-text" data-testid="web-quote-queue-view-client">
          Ver cliente →
        </Link>
      </div>
    </li>
  );
}

export default async function AdminWebQuotesInboxPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/web-quotes');
  }

  let rows: WebQuoteQueueRow[] = [];
  if (isDatabaseConfigured) {
    rows = await listWebQuoteQueue(prisma);
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/clients" className="hover:text-kairikos-text">← Volver al listado</Link>
      </div>
      <PageHeading
        eyebrow="Operador"
        title="Presupuestos de web"
        description="Clientes que pidieron presupuesto para el producto de web y todavía no lo tienen activo."
      />

      {!isDatabaseConfigured ? (
        <EmptyState title="Modo de demostración" description="Esta vista necesita una base de datos configurada." />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin presupuestos pendientes"
          description="Cuando un cliente pida presupuesto de web, aparecerá aquí."
        />
      ) : (
        <ul className="space-y-4" data-testid="web-quote-queue-list">
          {rows.map((row) => (
            <WebQuoteQueueCard key={row.clientProductId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
