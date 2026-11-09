import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { PageHeading } from '@/components/portal/PageHeading';
import { PremiumQuoteActions } from '@/components/admin/PremiumQuoteActions';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { round50, type QuoterEstimate } from '@/lib/premium-quoter-engine';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Presupuesto Web Premium · Admin',
  robots: { index: false, follow: false },
};

const FECHA = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeStyle: 'short' });
const EUROS = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: true });
const eur = (n: number) => `${EUROS.format(n)} €`;

// La web la escribe un desconocido: solo es enlace si es http(s), para que un
// «javascript:…» no acabe siendo un clic en el panel de operador.
const isHttp = (url: string) => /^https?:\/\//i.test(url);

export default async function AdminPremiumQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const { id } = await params;
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/presupuestos-premium/${id}`);
  }
  if (!isDatabaseConfigured || !z.string().uuid().safeParse(id).success) notFound();
  const row = await prisma.premiumQuoteRequest.findUnique({ where: { id } });
  if (!row) notFound();

  const estimate = row.estimate as unknown as QuoterEstimate;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={`Presupuesto Web Premium · ${row.sector}`}
        title={row.company}
        description={`Pedido el ${FECHA.format(row.createdAt)}`}
        actions={
          <Link href="/admin/portal/presupuestos-premium" className="btn-ghost print:hidden">
            ← Volver
          </Link>
        }
      />
      <PremiumQuoteActions id={row.id} status={row.status} />

      <section className="card space-y-1 text-sm">
        <h2 className="mb-2 text-base font-semibold">Contacto</h2>
        <p>{row.contactName}</p>
        <p>{row.email}</p>
        {row.phone ? <p>{row.phone}</p> : null}
        {row.website ? (
          <p>
            {isHttp(row.website) ? (
              <a href={row.website} target="_blank" rel="noreferrer nofollow" className="underline">
                {row.website}
              </a>
            ) : (
              row.website
            )}
          </p>
        ) : null}
        <p>Prefiere la llamada: {row.callSlot}</p>
      </section>

      <section className="card text-sm" data-testid="premium-quote-estimate">
        <h2 className="mb-2 text-base font-semibold">Estimación</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
          <dt className="text-kairikos-muted">Precio de lista</dt>
          <dd>{eur(round50(estimate.list))}</dd>
          <dt className="text-kairikos-muted">Precio ofrecido</dt>
          <dd className="font-semibold">{eur(estimate.total)}</dd>
          <dt className="text-kairikos-muted">Horquilla</dt>
          <dd>
            {eur(estimate.low)} – {eur(estimate.high)}
          </dd>
          <dt className="text-kairikos-muted">Cuota</dt>
          <dd>{eur(estimate.perMonth)}/mes</dd>
          <dt className="text-kairikos-muted">Servicios Kairikos</dt>
          <dd>{eur(estimate.monthly)}/mes</dd>
          <dt className="text-kairikos-muted">Plazo</dt>
          <dd>{estimate.weeks} semanas</dd>
        </dl>
        <h3 className="mb-1 mt-4 font-semibold">Desglose</h3>
        <ul className="divide-y divide-kairikos-border">
          {estimate.lines.map((l, i) => (
            <li key={`${l[0]}-${i}`} className="flex justify-between gap-4 py-1">
              <span>{l[0]}</span>
              <span className="whitespace-nowrap font-medium">{l[1]}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-kairikos-muted">
        Datos del presupuestador: versión {row.configVersion}. Privacidad aceptada el {FECHA.format(row.consentAt)} (texto {row.consentVersion}).
      </p>
    </div>
  );
}
