import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { PUBLIC_SECTORS } from '@/lib/public-draft-request';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Borradores pedidos · Operador',
  description: 'Negocios que han pedido ver su web desde kairikos.com.',
  robots: { index: false, follow: false },
};

// =============================================================================
// A11, capa 3 — la cola de trabajo que genera el formulario público.
//
// Cada fila es un negocio que escribió su nombre y su teléfono para ver su
// web. Eso es un lead, y de los buenos: no le hemos llamado nosotros, ha
// venido él. La pantalla existe para que esa cola se mire todas las mañanas y
// no se quede en una tabla que nadie abre.
//
// Sin acciones de momento a propósito: lo que hay que hacer con cada fila es
// LLAMAR, y eso no pasa por esta pantalla. Marcar como contactado se añadirá
// cuando el volumen lo pida; hasta entonces, una lista honesta es mejor que
// un flujo inventado.
// =============================================================================

const FECHA = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export default async function PublicDraftsPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/admin/login');

  // 20/10/2026 — los contactos de la calculadora. Se guardaban desde el 24/09
  // y no los enseñaba ninguna pantalla: el comentario de su ruta decía que
  // venían a esta cola, pero esta cola solo leía los borradores.
  const [requests, calculatorLeads] = isDatabaseConfigured
    ? await Promise.all([
        prisma.publicDraftRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
        prisma.calculatorLead.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      ])
    : [[], []];

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Borradores pedidos desde la web"
        description="Negocios que han usado «Ver cómo quedaría mi web» en kairikos.com. Cada uno es un lead: han dejado su contacto para verla."
      />

      {requests.length === 0 ? (
        <EmptyState
          title="Todavía no ha pedido nadie su borrador"
          description="Cuando alguien use el formulario de kairikos.com, aparecerá aquí con su contacto y su página."
        />
      ) : (
        <ul className="space-y-2" data-testid="public-drafts-list">
          {requests.map((row) => (
            <li key={row.id} className="card" data-testid="public-draft-row">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs uppercase tracking-wider text-kairikos-muted">
                    {FECHA.format(row.createdAt)} · {PUBLIC_SECTORS[row.sector]?.label ?? row.sector}
                  </p>
                  <h2 className="mt-1 text-base font-semibold">{row.businessName}</h2>
                  <p className="text-sm text-kairikos-muted">
                    {row.city} · {row.contact}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ConsentPill consentAt={row.marketingConsentAt} />
                  {row.contactedAt ? (
                    <span className="pill-success">Contactado</span>
                  ) : (
                    <span className="pill-warning">Por llamar</span>
                  )}
                  <a href={`/mi-web/${row.token}`} target="_blank" rel="noreferrer" className="btn-ghost text-sm">
                    Ver su borrador
                  </a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-2" aria-label="Contactos de la calculadora">
        <h2 className="text-lg font-semibold">Contactos de la calculadora de llamadas</h2>
        <p className="text-sm text-kairikos-muted">
          Quien hizo la cuenta de cuánto pierde en llamadas y pidió que le contáramos cómo recuperarlas.
        </p>
        {calculatorLeads.length === 0 ? (
          <EmptyState
            title="Todavía no ha dejado nadie su contacto en la calculadora"
            description="Cuando alguien lo haga en kairikos.com, aparecerá aquí y en el correo de las 8:30."
          />
        ) : (
          <ul className="space-y-2" data-testid="calculator-leads-list">
            {calculatorLeads.map((row) => (
              <li key={row.id} className="card" data-testid="calculator-lead-row">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-kairikos-muted">
                      {FECHA.format(row.createdAt)} · {PUBLIC_SECTORS[row.sector]?.label ?? row.sector}
                    </p>
                    <h3 className="mt-1 text-base font-semibold">{row.businessName ?? 'Sin nombre'}</h3>
                    <p className="text-sm text-kairikos-muted">
                      {row.city ? `${row.city} · ` : ''}
                      {row.contact}
                    </p>
                    <p className="mt-1 text-sm">
                      Pierde {row.missedCallsPerWeek} llamadas a la semana: unos{' '}
                      {Math.round(row.annualLossCents / 100).toLocaleString('es-ES')} € al año.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ConsentPill consentAt={row.marketingConsentAt} />
                    {row.contactedAt ? (
                      <span className="pill-success">Contactado</span>
                    ) : (
                      <span className="pill-warning">Por llamar</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Si marcó la casilla de comunicaciones comerciales. Sin ella se le puede
 *  llamar o mandarle lo que pidió, pero no escribirle con ofertas. */
function ConsentPill({ consentAt }: { consentAt: Date | null }) {
  return consentAt ? (
    <span className="pill-success" title={`Aceptó el ${FECHA.format(consentAt)}`}>
      Acepta ofertas
    </span>
  ) : (
    <span className="pill" title="No marcó la casilla de comunicaciones comerciales">
      Solo lo que pidió
    </span>
  );
}
