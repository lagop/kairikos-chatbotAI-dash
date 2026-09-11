import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { listRecallQueue } from '@/lib/recall';
import { listLeadsQueue } from '@/lib/leads';
import { listWebQuoteQueue } from '@/lib/web-quotes';
import { listSupportRequests } from '@/lib/support-requests';

// =============================================================================
// Inicio del panel de operador — antes, /admin/portal era un simple
// redirect a /admin/portal/clients (KAIA-13702/13715: "así viejos
// enlaces siguen aterrizando en algún sitio real"). Con la barra lateral
// ya construida, /clients puede volver a ser solo el listado, y esto
// se convierte en lo que de verdad falta: un resumen del negocio.
//
// Los cuatro contadores de bandejas reutilizan las MISMAS funciones que
// ya usa cada cola (listRecallQueue, listLeadsQueue, listWebQuoteQueue,
// listSupportRequests) — no se reimplementa el criterio de "pendiente"
// aquí; si esas queries cambian, este resumen cambia con ellas sin que
// nadie tenga que acordarse de tocar dos sitios.
// =============================================================================

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Inicio · Admin',
  description: 'Resumen del negocio: clientes recientes, productos contratados y trabajo pendiente.',
  alternates: { canonical: '/admin/portal' },
  robots: { index: false, follow: false },
};

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' });

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-kairikos-muted">{hint}</p> : null}
    </div>
  );
}

export default async function AdminHomePage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal');
  }

  if (!isDatabaseConfigured) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Operador" title="Inicio" />
        <EmptyState title="No disponible en modo demo" description="El resumen requiere una cuenta real conectada a base de datos." />
      </div>
    );
  }

  const [recentClients, activeClientProducts, totalClients, recallQueue, leadsQueue, webQuoteQueue, openSupport] = await Promise.all([
    prisma.chatbotClient.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { id: true, name: true, companyName: true, email: true, createdAt: true },
    }),
    prisma.clientProduct.findMany({
      where: { status: 'active' },
      select: { product: { select: { code: true, name: true, tier: true, priceCents: true, currency: true } } },
    }),
    prisma.chatbotClient.count(),
    listRecallQueue(prisma),
    listLeadsQueue(prisma),
    listWebQuoteQueue(prisma),
    listSupportRequests(prisma, { status: 'open' }),
  ]);

  // Agregado en JS, no en la consulta: el volumen de datos de este
  // negocio (decenas de clientes, no miles) hace que un groupBy de
  // Prisma no aporte nada frente a reducir el findMany de arriba, y así
  // se puede sacar el nombre/tier del producto sin una segunda consulta.
  const byProduct = new Map<string, { name: string; tier: string; count: number; currency: string }>();
  let mrrCents = 0;
  for (const cp of activeClientProducts) {
    const key = `${cp.product.code}:${cp.product.tier}`;
    const existing = byProduct.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byProduct.set(key, { name: cp.product.name, tier: cp.product.tier, count: 1, currency: cp.product.currency });
    }
    // 'web' no tiene cuota recurrente (priceCents=0, cobra por
    // presupuesto/setup) — queda fuera de la MRR sin ningún caso
    // especial, es justo lo que su priceCents en cero ya expresa.
    mrrCents += cp.product.priceCents;
  }
  const productRows = [...byProduct.values()].sort((a, b) => b.count - a.count);

  const queues = [
    { label: 'Altas de llamadas', count: recallQueue.length, href: '/admin/portal/recall' },
    { label: 'Leads sin cerrar', count: leadsQueue.length, href: '/admin/portal/leads' },
    { label: 'Presupuestos de web', count: webQuoteQueue.length, href: '/admin/portal/web-quotes' },
    { label: 'Solicitudes de ayuda', count: openSupport.length, href: '/admin/portal/support' },
  ];
  const pendingTotal = queues.reduce((sum, q) => sum + q.count, 0);

  return (
    <div className="space-y-8">
      <PageHeading eyebrow="Operador" title="Inicio" description="Resumen del negocio — clientes recientes, productos contratados y trabajo pendiente." />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Clientes" value={String(totalClients)} />
        <StatTile label="MRR estimada" value={EUR.format(mrrCents / 100)} hint="Suma de cuotas activas, sin 'web'" />
        <StatTile label="Productos activos" value={String(activeClientProducts.length)} />
        <StatTile label="Acciones pendientes" value={String(pendingTotal)} hint="En las 4 bandejas de trabajo" />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Bandejas pendientes</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {queues.map((q) => (
            <Link
              key={q.href}
              href={q.href}
              className="card flex items-center justify-between transition hover:border-kairikos-accent2/50"
              data-testid={`admin-home-queue-${q.href.replace(/\//g, '-')}`}
            >
              <span className="text-sm text-kairikos-muted">{q.label}</span>
              <span className={q.count > 0 ? 'pill-warning' : 'pill-muted'}>{q.count}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Productos contratados</h2>
          {productRows.length === 0 ? (
            <EmptyState title="Sin productos activos" description="Todavía no hay ningún ClientProduct en estado activo." />
          ) : (
            <div className="card overflow-hidden p-0">
              <table className="w-full text-sm">
                <thead className="bg-kairikos-surface2 text-left text-xs uppercase tracking-wider text-kairikos-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Producto</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Activos</th>
                  </tr>
                </thead>
                <tbody>
                  {productRows.map((p) => (
                    <tr key={`${p.name}-${p.tier}`} className="border-t border-kairikos-border/60">
                      <td className="px-4 py-2.5">
                        {p.name} <span className="text-kairikos-muted">({p.tier})</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Clientes recientes</h2>
          {recentClients.length === 0 ? (
            <EmptyState title="Sin clientes" description="Todavía no hay ningún cliente dado de alta." />
          ) : (
            <ul className="card divide-y divide-kairikos-border/60 p-0">
              {recentClients.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/admin/portal/${c.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition hover:bg-kairikos-surface"
                    data-testid="admin-home-recent-client"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.companyName || c.name}</span>
                      <span className="block truncate text-xs text-kairikos-muted">{c.email}</span>
                    </span>
                    <span className="shrink-0 text-xs text-kairikos-muted">{DATE_FORMAT.format(c.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
