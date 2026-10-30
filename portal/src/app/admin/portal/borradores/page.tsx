import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { PUBLIC_SECTORS } from '@/lib/public-draft-request';
import { MarkContactedButton } from '@/components/admin/MarkContactedButton';
import { emailFromContact } from '@/lib/inbound-follow-up';
import { SendPublicDraftButton } from '@/components/admin/SendPublicDraftButton';
import { deliveryDueAt } from '@/lib/public-draft-delivery';
import { MAX_GENERATION_ATTEMPTS } from '@/lib/public-draft-request';

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
// Lo que hay que hacer con cada fila es LLAMAR, y eso no pasa por esta
// pantalla. La única acción es «Marcar contactado» (25/10/2026), que llegó con
// el seguimiento por correo: es lo que lo corta en cuanto se ha hablado con
// alguien. Cada fila enseña también qué correos de seguimiento ha recibido.
//
// 30/10/2026 — y es donde se revisa el borrador antes de que le llegue
// (lib/public-draft-delivery.ts): «Revisar» lo enseña como lo verá, «Editar»
// abre el editor y «Enviar ahora» se lo manda sin esperar al plazo. Si nadie
// lo toca, sale solo a las 23 horas.
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

  // 25/10/2026 — los correos de seguimiento (lib/inbound-follow-up.ts) que ha
  // recibido cada contacto, para no llamar a ciegas a alguien que ya tiene
  // tres correos nuestros, ni escribir a quien se dio de baja.
  const followUps = isDatabaseConfigured
    ? await prisma.inboundFollowUpEmail.findMany({
        where: { sourceId: { in: [...requests.map((r) => r.id), ...calculatorLeads.map((r) => r.id)] } },
        orderBy: { createdAt: 'asc' },
        select: { sourceId: true, step: true, status: true, sentAt: true },
      })
    : [];
  const followUpsBySource = new Map<string, typeof followUps>();
  for (const f of followUps) {
    const list = followUpsBySource.get(f.sourceId) ?? [];
    list.push(f);
    followUpsBySource.set(f.sourceId, list);
  }

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
                    {row.phone ? ` · ${row.phone}` : ''}
                  </p>
                  <DeliveryLine row={row} />
                  <FollowUpLine
                    sends={followUpsBySource.get(row.id) ?? []}
                    unsubscribedAt={row.unsubscribedAt}
                    consent={row.marketingConsentAt !== null}
                    isEmail={emailFromContact(row.contact) !== null}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <ConsentPill consentAt={row.marketingConsentAt} />
                  {row.contactedAt ? (
                    <span className="pill-success">Contactado</span>
                  ) : (
                    <>
                      <span className="pill-warning">Por llamar</span>
                      <MarkContactedButton source="web_draft" id={row.id} />
                    </>
                  )}
                  {row.copy ? (
                    <>
                      <a href={`/api/admin/portal/borradores/${row.id}/ver`} target="_blank" rel="noreferrer" className="btn-ghost text-sm">
                        {row.sentAt ? 'Ver su borrador' : 'Revisar'}
                      </a>
                      {row.templateId ? (
                        <a href={`/admin/portal/borradores/${row.id}`} className="btn-ghost text-sm" data-testid="public-draft-edit">
                          Editar
                        </a>
                      ) : null}
                      {!row.sentAt || row.deliveryError ? (
                        <SendPublicDraftButton id={row.id} label={row.sentAt ? 'Reintentar correo' : 'Enviar ahora'} />
                      ) : null}
                    </>
                  ) : null}
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
                    <FollowUpLine
                      sends={followUpsBySource.get(row.id) ?? []}
                      unsubscribedAt={row.unsubscribedAt}
                      consent={row.marketingConsentAt !== null}
                      isEmail={emailFromContact(row.contact) !== null}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <ConsentPill consentAt={row.marketingConsentAt} />
                    {row.contactedAt ? (
                      <span className="pill-success">Contactado</span>
                    ) : (
                      <>
                        <span className="pill-warning">Por llamar</span>
                        <MarkContactedButton source="calculator" id={row.id} />
                      </>
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

/** En qué punto está la entrega de su borrador (lib/public-draft-delivery.ts). */
function DeliveryLine({
  row,
}: {
  row: { copy: unknown; sentAt: Date | null; createdAt: Date; generationAttempts: number; deliveryError: string | null; contact: string };
}) {
  let text: string;
  let tone = 'text-kairikos-muted';
  if (!row.copy) {
    if (row.generationAttempts >= MAX_GENERATION_ATTEMPTS) {
      text = 'No se pudo escribir su borrador tras varios intentos: escríbele tú.';
      tone = 'text-kairikos-danger';
    } else {
      text = 'Escribiendo su borrador…';
    }
  } else if (!row.sentAt) {
    text = `Sin enviar: sale solo el ${FECHA.format(deliveryDueAt(row.createdAt))} si no lo mandas antes.`;
    tone = 'text-kairikos-warning';
  } else if (row.deliveryError) {
    text = `Enlace abierto el ${FECHA.format(row.sentAt)}, pero el correo falló: ${row.deliveryError}`;
    tone = 'text-kairikos-danger';
  } else if (!emailFromContact(row.contact)) {
    text = `Enlace abierto el ${FECHA.format(row.sentAt)}. No dejó correo: llámale para mandárselo.`;
    tone = 'text-kairikos-warning';
  } else {
    text = `Enviado el ${FECHA.format(row.sentAt)}.`;
  }
  return (
    <p className={`mt-1 text-xs ${tone}`} data-testid="public-draft-delivery">
      {text}
    </p>
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

const STEP_LABEL: Record<string, string> = { dia_0: 'día 0', dia_3: 'día 3', dia_7: 'día 7' };

/** Qué correos de seguimiento ha recibido. Los «skipped» (no tocaban) no se
 *  enseñan: no son nada que la persona haya visto. */
function FollowUpLine({
  sends,
  unsubscribedAt,
  consent,
  isEmail,
}: {
  sends: Array<{ step: string; status: string; sentAt: Date | null }>;
  unsubscribedAt: Date | null;
  consent: boolean;
  isEmail: boolean;
}) {
  const visibles = sends.filter((s) => s.status !== 'skipped');
  if (!consent && !unsubscribedAt) return null;
  if (!isEmail) {
    return (
      <p className="mt-1 text-xs text-kairikos-muted" data-testid="follow-up-line">
        Sin seguimiento por correo: dejó un teléfono.
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-kairikos-muted" data-testid="follow-up-line">
      {unsubscribedAt ? (
        <span className="font-semibold text-kairikos-danger">Se dio de baja el {FECHA.format(unsubscribedAt)}. </span>
      ) : null}
      {visibles.length === 0
        ? 'Seguimiento por correo: ninguno todavía.'
        : 'Seguimiento por correo: ' +
          visibles
            .map((s) =>
              s.status === 'sent' && s.sentAt
                ? `${STEP_LABEL[s.step] ?? s.step} (${FECHA.format(s.sentAt)})`
                : `${STEP_LABEL[s.step] ?? s.step} (${s.status === 'failed' ? 'falló' : 'enviando'})`,
            )
            .join(' · ')}
    </p>
  );
}
