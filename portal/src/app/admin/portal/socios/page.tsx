import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { loadCommissionReport } from '@/lib/referrals';
import { createReferralCodeAction, toggleReferralCodeAction } from './actions';

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
// Los códigos se dan de alta aquí desde el 24/09/2026. Antes se creaban a
// mano en la base de datos, lo que era razonable mientras nadie los usara;
// dejó de serlo al enchufar la captura en /empezar, porque un código que hay
// que crear con un INSERT no se reparte nunca. Lo que se reparte es el
// ENLACE de cada fila, no el código suelto: quien lo pulsa llega al alta con
// el código ya escrito y no tiene que teclear nada.
// =============================================================================

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

export default async function PartnersPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/admin/login');

  const rows = isDatabaseConfigured ? await loadCommissionReport(prisma) : [];
  // Para el desplegable de referidos: quién puede recomendar es quien ya es
  // cliente. Un referido de alguien que no lo es es un socio, y ese se da de
  // alta por el otro lado del formulario.
  const clientes = isDatabaseConfigured
    ? await prisma.chatbotClient.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 })
    : [];

  const origin = process.env.NEXT_PUBLIC_PORTAL_URL ?? '';

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Socios y referidos"
        description="Quién ha traído a quién, y cuánto hay que pagarle este mes."
      />

      <section className="card space-y-4">
        <h2 className="text-sm font-semibold">Crear un código</h2>

        <form action={createReferralCodeAction} className="grid gap-3 sm:grid-cols-2" data-testid="partner-create-form">
          <input type="hidden" name="kind" value="partner" />
          <div className="sm:col-span-2 text-xs uppercase tracking-wider text-kairikos-muted">Socio</div>
          <div>
            <label className="label" htmlFor="partner-nombre">
              Nombre del socio
            </label>
            <input id="partner-nombre" name="nombre" className="input" placeholder="Almacenes Saltoki" maxLength={200} />
          </div>
          <div>
            <label className="label" htmlFor="partner-email">
              Correo (opcional)
            </label>
            <input id="partner-email" name="email" className="input" type="email" maxLength={200} />
          </div>
          <div>
            <label className="label" htmlFor="partner-porcentaje">
              Comisión recurrente (%)
            </label>
            <input
              id="partner-porcentaje"
              name="porcentaje"
              className="input"
              type="number"
              min={0}
              max={100}
              defaultValue={20}
            />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full sm:w-auto">
              Crear código de socio
            </button>
          </div>
        </form>

        <form action={createReferralCodeAction} className="grid gap-3 sm:grid-cols-2" data-testid="referral-create-form">
          <input type="hidden" name="kind" value="referral" />
          <div className="sm:col-span-2 border-t border-kairikos-border pt-4 text-xs uppercase tracking-wider text-kairikos-muted">
            Referido de un cliente
          </div>
          <div>
            <label className="label" htmlFor="referral-cliente">
              Cliente que recomienda
            </label>
            <select id="referral-cliente" name="clienteId" className="input" defaultValue="">
              <option value="" disabled>
                Elige un cliente
              </option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-ghost w-full sm:w-auto">
              Crear código de referido
            </button>
          </div>
          <p className="sm:col-span-2 text-xs text-kairikos-muted">
            Un referido no cobra comisión: su premio es un mes gratis, que se aplica con un cupón de Stripe.
          </p>
        </form>
      </section>

      {rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay códigos"
          description="Crea uno arriba y reparte su enlace. Cuando alguien llegue con él, aparecerá aquí con su comisión."
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
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code} className="border-t border-kairikos-border">
                  <td className="py-2">
                    <div className="font-mono text-xs">{row.code}</div>
                    <div className="text-xs text-kairikos-muted">{`${origin}/empezar?ref=${row.code}`}</div>
                  </td>
                  <td className="py-2">{row.beneficiario}</td>
                  <td className="py-2 text-kairikos-muted">
                    {row.kind === 'partner' ? 'Socio' : 'Referido'}
                    {row.active ? '' : ' · retirado'}
                  </td>
                  <td className="py-2">{row.clientesTraidos}</td>
                  <td className="py-2">{EUR.format(row.mrrTraidoCents / 100)}</td>
                  <td className="py-2 font-medium">
                    {row.kind === 'partner' ? (
                      EUR.format(row.comisionMensualCents / 100)
                    ) : (
                      <span className="text-kairikos-muted">1 mes gratis</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <form action={toggleReferralCodeAction}>
                      <input type="hidden" name="code" value={row.code} />
                      <button type="submit" className="btn-ghost text-xs">
                        {row.active ? 'Retirar' : 'Reactivar'}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-kairikos-muted">
            La comisión se calcula sobre los ingresos recurrentes activos de los clientes que trajo cada uno. Un
            cliente que se da de baja deja de generar comisión. Retirar un código impide nuevas atribuciones, pero no
            borra las que ya trajo.
          </p>
        </section>
      )}
    </div>
  );
}
