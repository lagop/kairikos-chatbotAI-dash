import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Clientes · Operador',
  description: 'Listado de todos los clientes del portal y su estado (sólo lectura).',
  alternates: { canonical: '/admin/portal' },
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

const TIER_LABEL: Record<string, string> = {
  starter: 'Web Starter',
  pro: 'Web Pro',
  premium: 'Web Premium',
};

export default async function AdminPortalIndexPage() {
  // KAIA-2857 — wrap getSession() in try/catch so a Prisma init or auth()
  // crash falls back to the login redirect instead of the Vercel 500 page.
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[admin/portal] getSession() crashed, redirecting to login:', err);
    redirect('/portal/login?next=/admin/portal');
  }
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal');
  }
  let rows: Array<{
    id: string;
    companyName: string;
    email: string;
    tier: string;
    goLiveAt: Date | null;
  }> = [];
  if (isDatabaseConfigured) {
    try {
      const dbRows = await prisma.chatbotClient.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          companyName: true,
          name: true,
          email: true,
          tier: true,
          goLiveAt: true,
        },
      });
      rows = dbRows.map((r) => ({
        id: r.id,
        companyName: r.companyName ?? r.name,
        email: r.email,
        tier: r.tier,
        goLiveAt: r.goLiveAt,
      }));
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    rows = [
      { id: MOCK_CLIENT.id, companyName: MOCK_CLIENT.companyName, email: MOCK_CLIENT.primaryContactEmail, tier: MOCK_CLIENT.tier, goLiveAt: MOCK_CLIENT.goLiveDate ? new Date(MOCK_CLIENT.goLiveDate) : null },
      { id: MOCK_SECONDARY_CLIENT.id, companyName: MOCK_SECONDARY_CLIENT.companyName, email: MOCK_SECONDARY_CLIENT.primaryContactEmail, tier: MOCK_SECONDARY_CLIENT.tier, goLiveAt: MOCK_SECONDARY_CLIENT.goLiveDate ? new Date(MOCK_SECONDARY_CLIENT.goLiveDate) : null },
    ];
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Portal de clientes"
        description={`${rows.length} cliente${rows.length === 1 ? '' : 's'} en el portal. Vista de sólo lectura.`}
        actions={
          <form action="/api/portal/operator" method="post">
            <input type="hidden" name="mode" value="disable" />
            <input type="hidden" name="return_to" value="/admin/portal" />
            <button type="submit" className="btn-ghost">Salir del modo operador</button>
          </form>
        }
      />

      <div className="card overflow-x-auto" aria-label="Listado de clientes">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-kairikos-muted">
              <th scope="col" className="pb-3 pr-4">Cliente</th>
              <th scope="col" className="pb-3 pr-4">Email</th>
              <th scope="col" className="pb-3 pr-4">Plan</th>
              <th scope="col" className="pb-3 pr-4">Estado</th>
              <th scope="col" className="pb-3">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kairikos-border">
            {rows.map((row) => {
              const statusKey = row.goLiveAt ? 'live' : 'in_progress';
              return (
                <tr key={row.id} data-testid="admin-client-row" data-client-id={row.id}>
                  <td className="py-3 pr-4 font-medium">{row.companyName}</td>
                  <td className="py-3 pr-4 text-kairikos-muted">{row.email}</td>
                  <td className="py-3 pr-4">{TIER_LABEL[row.tier] ?? row.tier}</td>
                  <td className="py-3 pr-4">
                    <span className={STATUS_PILL[statusKey] ?? 'pill-muted'}>
                      {STATUS_LABEL[statusKey] ?? statusKey}
                    </span>
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/admin/portal/${row.id}`}
                      className="text-kairikos-accent2 underline"
                      data-testid="admin-client-open"
                    >
                      Ver portal →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
