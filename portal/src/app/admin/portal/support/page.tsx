import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { listSupportRequests, type SupportRequestRow } from '@/lib/support-requests';
import { setSupportRequestStatusAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Solicitudes de ayuda · Admin',
  description: 'Bandeja de solicitudes de ayuda enviadas por clientes desde el portal.',
  alternates: { canonical: '/admin/portal/support' },
  robots: { index: false, follow: false },
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

type FilterValue = 'open' | 'resolved' | 'all';

function FilterLink({ current, value, label }: { current: FilterValue; value: FilterValue; label: string }) {
  const active = current === value;
  const href = value === 'open' ? '/admin/portal/support' : `/admin/portal/support?filter=${value}`;
  return (
    <Link
      href={href}
      className={active ? 'btn-primary' : 'btn-ghost'}
      data-testid={`support-filter-${value}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

function SupportRequestCard({ request }: { request: SupportRequestRow }) {
  const isResolved = request.status === 'resolved';
  return (
    <li
      className="card space-y-3"
      data-testid="support-request-row"
      data-status={request.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">
            {request.clientName} · {request.clientEmail}
          </p>
          <h3 className="mt-1 text-base font-semibold">{request.subject}</h3>
        </div>
        <span className={isResolved ? 'pill-success' : 'pill-warning'}>
          {isResolved ? 'Resuelta' : 'Abierta'}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-kairikos-text">{request.message}</p>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kairikos-border pt-3 text-xs text-kairikos-muted">
        <span>
          Enviada el {DATE_FORMAT.format(new Date(request.createdAt))}
          {isResolved && request.resolvedAt
            ? ` · Resuelta el ${DATE_FORMAT.format(new Date(request.resolvedAt))}${
                request.resolvedByOperatorId ? ` por ${request.resolvedByOperatorId}` : ''
              }`
            : ''}
        </span>
        <div className="flex items-center gap-3">
          <Link href={`/admin/portal/${request.clientId}`} className="underline hover:text-kairikos-text">
            Ver cliente
          </Link>
          <form action={setSupportRequestStatusAction}>
            <input type="hidden" name="id" value={request.id} />
            <input type="hidden" name="status" value={isResolved ? 'open' : 'resolved'} />
            <button
              type="submit"
              className="btn-ghost"
              data-testid={isResolved ? 'support-reopen' : 'support-resolve'}
            >
              {isResolved ? 'Reabrir' : 'Marcar como resuelta'}
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}

export default async function AdminSupportInboxPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/support');
  }

  const filter: FilterValue =
    searchParams.filter === 'resolved' ? 'resolved' : searchParams.filter === 'all' ? 'all' : 'open';

  let requests: SupportRequestRow[] = [];
  if (isDatabaseConfigured) {
    requests = await listSupportRequests(prisma, filter === 'all' ? {} : { status: filter });
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/clients" className="hover:text-kairikos-text">← Volver al listado</Link>
      </div>
      <PageHeading
        eyebrow="Operador"
        title="Solicitudes de ayuda"
        description="Mensajes que los clientes han enviado desde el botón «Necesito ayuda» del portal."
      />

      <nav aria-label="Filtro de solicitudes" className="card flex flex-wrap items-center gap-2 p-3" data-testid="support-filter-bar">
        <FilterLink current={filter} value="open" label="Abiertas" />
        <FilterLink current={filter} value="resolved" label="Resueltas" />
        <FilterLink current={filter} value="all" label="Todas" />
      </nav>

      {!isDatabaseConfigured ? (
        <EmptyState
          title="Modo de demostración"
          description="Esta vista necesita una base de datos configurada."
        />
      ) : requests.length === 0 ? (
        <EmptyState
          title={filter === 'open' ? 'Sin solicitudes abiertas' : 'Sin solicitudes'}
          description="Cuando un cliente pida ayuda desde el portal, aparecerá aquí."
        />
      ) : (
        <ul className="space-y-4" data-testid="support-request-list">
          {requests.map((r) => (
            <SupportRequestCard key={r.id} request={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
