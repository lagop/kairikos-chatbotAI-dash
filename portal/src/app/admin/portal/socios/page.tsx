import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { loadCommissionReport } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Socios y referidos · Operador',
  description: 'Quién ha traído a quién y cuánto hay que pagarle.',
  robots: { index: false, follow: false },
};

// =============================================================================
// A7 — la pantalla que se mira antes de pagar comisiones.
//
// La cifra que importa es la última columna, y la explicación está en la
// penúltima: la comisión sale del MRR ACTIVO de los clientes que trajo cada
// uno. Si un cliente se da de baja, esa comisión se acaba — y eso es lo que
// hace que al socio le interese traer clientes que se queden.
//
// Los códigos se crean todavía a mano en la base de datos. Es deliberado: con
// tres socios, una pantalla de alta es más trabajo que valor, y el día que
// haya treinta ya se sabrá qué campos hacen falta de verdad.
// =============================================================================

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

export default async function PartnersPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/admin/login');

  const rows = isDatabaseConfigured ? await loadCommissionReport(prisma) : [];

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Socios y referidos"
        description="Quién ha traído a quién, y cuánto hay que pagarle este mes."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay códigos"
          description="Cuando exista un código de socio o de referido y alguien llegue con él, aparecerá aquí con su comisión."
        />
      ) : (
        <section className="card">
          <table className="w-full text-sm" data-testid="partners-table">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-kairikos-muted">
                <th className="pb-2">Código</th>
                <th className="pb-2">Quién</th>
                <th className="pb-2">Tipo</th>
                <th className="pb-2">Clientes</th>
                <th className="pb-2">Ingresos que trajo</th>
                <th className="pb-2">Comisión al mes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code} className="border-t border-kairikos-border">
                  <td className="py-2 font-mono text-xs">{row.code}</td>
                  <td className="py-2">{row.beneficiario}</td>
                  <td className="py-2 text-kairikos-muted">{row.kind === 'partner' ? 'Socio' : 'Referido'}</td>
                  <td className="py-2">{row.clientesTraidos}</td>
                  <td className="py-2">{EUR.format(row.mrrTraidoCents / 100)}</td>
                  <td className="py-2 font-medium">
                    {row.kind === 'partner' ? (
                      EUR.format(row.comisionMensualCents / 100)
                    ) : (
                      <span className="text-kairikos-muted">1 mes gratis</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-kairikos-muted">
            La comisión se calcula sobre los ingresos recurrentes activos de los clientes que trajo cada uno. Un
            cliente que se da de baja deja de generar comisión.
          </p>
        </section>
      )}
    </div>
  );
}
