import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { loadBusinessMetrics } from '@/lib/business-metrics';
import { PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Métricas del negocio · Operador',
  description: 'Ingresos recurrentes, embudo comercial y bajas.',
  robots: { index: false, follow: false },
};

// =============================================================================
// A9 — la pantalla de la revisión semanal de 15 minutos.
//
// Lo que se enseña y lo que NO: aquí van ingresos recurrentes, embudo y bajas.
// No hay gráficas de evolución porque todavía no hay historia que dibujar, y
// una línea de tres puntos sugiere una tendencia que no existe. Cuando haya
// meses de datos, ese será el momento.
//
// Tampoco hay "objetivos" ni semáforos: el plan tiene los suyos y esto es lo
// que pasó, no una nota. Mezclar las dos cosas hace que se mire la nota en
// vez del número.
// =============================================================================

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 1 });

export default async function BusinessMetricsPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/admin/login');

  if (!isDatabaseConfigured) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Operador" title="Métricas del negocio" description="No disponible en modo demo." />
        <EmptyState title="Sin base de datos" description="Esta pantalla lee datos reales." />
      </div>
    );
  }

  const m = await loadBusinessMetrics(prisma);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Métricas del negocio"
        description="Lo que hay que mirar una vez por semana: qué entra, de dónde viene y quién se va."
      />

      <section className="grid gap-4 sm:grid-cols-3" data-testid="metrics-headline">
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Ingresos recurrentes</p>
          <p className="mt-1 text-3xl font-semibold">{EUR.format(m.mrrTotalCents / 100)}</p>
          <p className="mt-1 text-xs text-kairikos-muted">al mes, de lo contratado hoy</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Clientes activos</p>
          <p className="mt-1 text-3xl font-semibold">{m.clientesConAlgoActivo}</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {m.clientesMultiproducto} con dos o más productos
            {m.ratioMultiproducto !== null ? ` · ${PCT.format(m.ratioMultiproducto)}` : ''}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Bajas (30 días)</p>
          <p className="mt-1 text-3xl font-semibold">{m.bajas30d}</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {m.churnMensual === null ? 'sin clientes todavía' : `${PCT.format(m.churnMensual)} del total`}
          </p>
        </div>
      </section>

      <section className="card" aria-label="Ingresos por producto">
        <h2 className="mb-3 text-lg font-semibold">De dónde vienen los ingresos</h2>
        {m.porProducto.length === 0 ? (
          <p className="text-sm text-kairikos-muted">Todavía no hay ningún producto activo.</p>
        ) : (
          <table className="w-full text-sm" data-testid="metrics-by-product">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-kairikos-muted">
                <th className="pb-2">Producto</th>
                <th className="pb-2">Tarifa</th>
                <th className="pb-2">Clientes</th>
                <th className="pb-2">Al mes</th>
              </tr>
            </thead>
            <tbody>
              {m.porProducto.map((row) => (
                <tr key={`${row.productCode}-${row.tier}`} className="border-t border-kairikos-border">
                  <td className="py-2">{PRODUCT_CATALOGS[row.productCode as ProductCode]?.label ?? row.productCode}</td>
                  <td className="py-2 text-kairikos-muted">{row.tier}</td>
                  <td className="py-2">{row.clientes}</td>
                  <td className="py-2 font-medium">{EUR.format(row.mrrCents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-label="Embudo comercial">
        <h2 className="mb-1 text-lg font-semibold">El embudo</h2>
        <p className="mb-3 text-xs text-kairikos-muted">
          Acumulado desde el principio, no de este mes: con estos volúmenes, una ventana mensual daría cifras de
          una cifra y ninguna conclusión.
        </p>
        <ul className="space-y-2" data-testid="metrics-funnel">
          {m.embudo.map((row) => (
            <li key={row.etapa} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{row.etapa}</span>
              <span className="text-xs text-kairikos-muted">{row.detalle}</span>
              <span className="text-lg font-semibold">{row.valor}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-label="Estadísticas de mercado">
        <h2 className="mb-1 text-lg font-semibold">Datos de mercado</h2>
        <p className="mb-3 text-sm text-kairikos-muted">
          Lo que han visto los barridos, agregado por sector y zona. Es el material de los estudios con datos
          propios: solo salen grupos de 10 negocios o más, para que ningún negocio concreto sea deducible.
        </p>
        <a href="/api/admin/portal/sector-stats" className="btn-ghost text-sm" download>
          Descargar CSV
        </a>
      </section>
    </div>
  );
}
