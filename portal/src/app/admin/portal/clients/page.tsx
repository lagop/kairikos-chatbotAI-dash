import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { listAdminClients } from '@/lib/portal-data';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Clientes · Admin',
  description: 'Listado de clientes y su estado en el portal (sólo lectura).',
  alternates: { canonical: '/admin/portal/clients' },
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  in_progress: 'En curso',
  live: 'En producción',
  paused: 'En pausa',
  cancelled: 'Cancelado',
};

const STATUS_PILL: Record<string, string> = {
  pending: 'pill-muted',
  in_progress: 'pill-warning',
  live: 'pill-success',
  paused: 'pill-warning',
  cancelled: 'pill-danger',
};

export default async function AdminClientsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/clients');
  }
  const clients = await listAdminClients();
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Clientes del portal"
        description="Vista de soporte de sólo lectura. Selecciona un cliente para ver el detalle en su portal."
      />
      <form action="/admin/portal/clients" method="get" className="card flex items-center gap-3 p-3">
        <label htmlFor="search" className="sr-only">
          Buscar cliente
        </label>
        <input
          id="search"
          type="search"
          name="search"
          placeholder="Buscar por nombre…"
          className="input"
        />
        <button type="submit" className="btn-ghost">
          Buscar
        </button>
      </form>
      {clients.length === 0 ? (
        <EmptyState title="Sin clientes" description="No hay clientes dados de alta en el portal." />
      ) : (
        <section className="card overflow-hidden p-0" aria-label="Listado de clientes">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-kairikos-surface2 text-left text-xs uppercase tracking-wider text-kairikos-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">Cliente</th>
                  <th scope="col" className="px-4 py-3">Email</th>
                  <th scope="col" className="px-4 py-3">Plan</th>
                  <th scope="col" className="px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-t border-kairikos-border/60" data-testid="client-row">
                    <td className="px-4 py-3 align-middle">
                      <div className="font-semibold">{c.companyName}</div>
                      <div className="text-xs text-kairikos-muted">/{c.slug}</div>
                    </td>
                    <td className="px-4 py-3 align-middle" data-testid="client-email">
                      <a
                        href={`mailto:${c.primaryContactEmail}`}
                        className="text-kairikos-accent2 hover:underline"
                      >
                        {c.primaryContactEmail}
                      </a>
                    </td>
                    <td className="px-4 py-3 align-middle capitalize">{c.tier}</td>
                    <td className="px-4 py-3 align-middle">
                      <span
                        className={STATUS_PILL[c.onboardingStatus] ?? 'pill-muted'}
                        data-testid="client-status"
                        data-status={c.onboardingStatus}
                      >
                        {STATUS_LABEL[c.onboardingStatus] ?? c.onboardingStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
