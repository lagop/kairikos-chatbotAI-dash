import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { listAdminClients } from '@/lib/portal-data';
import { getSession } from '@/lib/session';
import { onboardingStatusLabel, onboardingStatusPillClass } from '@/lib/onboarding-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Clientes · Admin',
  description: 'Listado de clientes y su estado en el portal (sólo lectura).',
  alternates: { canonical: '/admin/portal/clients' },
  robots: { index: false, follow: false },
};

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: { search?: string };
}) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/clients');
  }
  // WP-06 — listAdminClients() has taken a search param since KAIA-13715,
  // but this page never read searchParams.search and passed it through:
  // the search form below submitted a query string the query never used.
  const search = searchParams.search ?? '';
  const clients = await listAdminClients(search);
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Clientes del portal"
        description="Vista de soporte de sólo lectura. Selecciona un cliente para ver el detalle en su portal."
        actions={
          <form action="/api/portal/operator" method="post">
            <input type="hidden" name="mode" value="disable" />
            <input type="hidden" name="return_to" value="/admin/portal/clients" />
            <button type="submit" className="btn-ghost">Salir del modo operador</button>
          </form>
        }
      />
      <form action="/admin/portal/clients" method="get" className="card flex items-center gap-3 p-3">
        <label htmlFor="search" className="sr-only">
          Buscar cliente
        </label>
        <input
          id="search"
          type="search"
          name="search"
          defaultValue={search}
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
                  <th scope="col" className="px-4 py-3 text-right">Acción</th>
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
                        className={onboardingStatusPillClass(c.onboardingStatus)}
                        data-testid="client-status"
                        data-status={c.onboardingStatus}
                      >
                        {onboardingStatusLabel(c.onboardingStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-middle text-right">
                      <Link
                        href={`/admin/portal/${c.id}`}
                        className="text-kairikos-accent2 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kairikos-accent2 focus-visible:rounded-sm"
                        data-testid="client-row-action"
                      >
                        Abrir →
                      </Link>
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
