import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { loadRecallClientView, type RecallCallSummary } from '@/lib/recall-client-view';
import { monthLabel } from '@/lib/recall-reports';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { EmptyState } from '@/components/portal/EmptyState';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // No ' · Portal Kairikos' suffix: the root layout's metadata
  // template already appends it, and repeating it renders the name
  // twice in the tab.
  title: 'Llamadas recuperadas',
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-XX — the client's own view of the 'recall' service.
//
// The product is run entirely from WhatsApp and never requires a login.
// This page exists for the once or twice a month an owner wants to see
// the numbers himself — recovered calls are invisible by nature, so
// "nothing bad happened" is the only evidence he otherwise gets — and so
// that the portal home has a reason to show him the rest of the
// catalogue while he is here.
//
// READ-ONLY on purpose: which calls became a job is decided by replying
// to the 19:00 digest, and giving that decision a second writer would let
// the two disagree. See src/lib/recall-client-view.ts.
// =============================================================================

const STATUS_COPY: Record<string, { title: string; description: string }> = {
  paid: {
    title: 'Estamos preparando tu servicio',
    description: 'Hemos recibido tu alta. En breve te contactamos para firmar y configurarlo todo.',
  },
  contract_signed: {
    title: 'Contrato firmado',
    description: 'El siguiente paso es conectar tu WhatsApp. Te escribimos nosotros, no tienes que hacer nada.',
  },
  meta_connected: {
    title: 'WhatsApp conectado',
    description: 'Ya podemos escribir desde tu número. Estamos asignándote la línea que recogerá las llamadas.',
  },
  number_assigned: {
    title: 'Línea asignada',
    description: 'Falta que Meta apruebe los mensajes que enviaremos en tu nombre. Suele tardar unas horas.',
  },
  templates_approved: {
    title: 'Mensajes aprobados',
    description: 'Ya solo queda activar el desvío en tu teléfono. Te mandamos las instrucciones por WhatsApp.',
  },
  forwarding_pending: {
    title: 'Falta activar el desvío',
    description:
      'Es el último paso y lo tienes que hacer tú desde tu móvil: son unos segundos. Te hemos enviado las instrucciones por WhatsApp.',
  },
  forwarding_verified: {
    title: 'Desvío verificado',
    description: 'Todo listo. Estamos haciendo la última comprobación antes de activarlo.',
  },
  paused: {
    title: 'Servicio en pausa',
    description: 'Nos pediste parar el servicio. Escríbenos cuando quieras reanudarlo.',
  },
  cancelled: {
    title: 'Servicio cancelado',
    description: 'Este servicio está cancelado. Tus datos siguen aquí por si vuelves.',
  },
};

const OUTCOME_LABEL: Record<string, string> = {
  recorded: 'Dejó un recado',
  no_message: 'Colgó sin dejar recado',
  withheld: 'Número oculto',
  pending: 'En curso',
};

const NOTIFY_LABEL: Record<string, string> = {
  whatsapp: 'Le escribimos por WhatsApp',
  sms: 'Le escribimos por SMS',
  sms_fallback: 'Le escribimos por SMS',
  throttled: 'Ya le habíamos escrito ese día',
  blocked: 'Número bloqueado por ti',
  unreachable: 'No pudimos escribirle',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function notifyLabel(call: RecallCallSummary): string {
  if (call.callerNotifyChannel) {
    return NOTIFY_LABEL[call.callerNotifyChannel] ?? call.callerNotifyChannel;
  }
  // A hidden number can never be written back to, so "pendiente" would be
  // a promise that cannot be kept.
  if (call.withheld) return 'Sin número al que escribir';
  return 'Le escribiremos en unos minutos';
}

function Metric({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="card p-4">
      <dt className="text-xs uppercase tracking-wide text-kairikos-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
      {hint ? <p className="mt-1 text-xs text-kairikos-muted">{hint}</p> : null}
    </div>
  );
}

export default async function PortalLlamadasPage() {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/llamadas');
  }

  const view =
    isDatabaseConfigured && resolved.source === 'database'
      ? await loadRecallClientView(prisma, resolved.clientId)
      : ({ state: 'not_contracted' } as const);

  if (view.state === 'not_contracted') {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title="Llamadas recuperadas" />
        <ProductPitch
          tagline="Cada llamada que no coges es un cliente que llama al siguiente de la lista."
          features={[
            'Cuando no puedes atender, un asistente contesta con tu propia voz grabada y toma el recado.',
            'Te llega el recado transcrito por WhatsApp en segundos, y a quien llamó le escribimos desde tu número.',
            'Al día siguiente pedimos reseña en Google a los clientes que tú nos digas.',
            'No tienes que aprender nada ni abrir ningún panel: todo ocurre en el WhatsApp que ya usas.',
          ]}
          priceNote="Desde 149 €/mes. Se instala en 48 horas."
        >
          <EmptyState
            title="Habla con nosotros"
            description="Todavía no lo puedes contratar tú mismo desde el portal. Escríbenos y lo dejamos montado."
            action={
              <Link href="/portal/support" className="btn-primary">
                Quiero información
              </Link>
            }
          />
        </ProductPitch>
      </div>
    );
  }

  if (view.state === 'onboarding') {
    const copy = STATUS_COPY[view.status] ?? {
      title: 'Estamos configurando tu servicio',
      description: 'Te avisamos por WhatsApp en cuanto esté listo.',
    };
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title="Llamadas recuperadas" />
        <div className="card p-5" data-testid="recall-client-onboarding" data-status={view.status}>
          <h2 className="text-base font-semibold">{copy.title}</h2>
          <p className="mt-2 text-sm text-kairikos-muted">{copy.description}</p>
          {view.virtualNumber ? (
            <p className="mt-3 text-sm">
              Tu línea de recados: <span className="font-medium tabular-nums">{view.virtualNumber}</span>
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const { metrics, history, calls } = view;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Portal"
        title="Llamadas recuperadas"
        description="Todo esto también te llega por WhatsApp. Esta página es solo para consultarlo cuando quieras."
      />

      <section aria-label={`Resumen de ${monthLabel(view.localMonth)}`}>
        <h2 className="mb-2 text-sm font-semibold capitalize">{monthLabel(view.localMonth)}</h2>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="recall-client-metrics">
          <Metric
            label="Llamadas recuperadas"
            value={String(metrics.calls)}
            hint="Llamadas que habrías perdido"
            testId="recall-client-recovered"
          />
          <Metric
            label="Contactados"
            value={String(metrics.contacted)}
            hint="Les escribimos desde tu número"
            testId="recall-client-contacted"
          />
          <Metric
            label="Reseñas nuevas"
            value={String(metrics.newReviews)}
            testId="recall-client-reviews"
          />
          <Metric
            label="Valoración"
            value={metrics.averageRating === null ? '—' : metrics.averageRating.toFixed(1)}
            hint={metrics.averageRating === null ? 'Sin reseñas este mes' : 'Media de las nuevas'}
            testId="recall-client-rating"
          />
        </dl>
      </section>

      {history.length > 0 ? (
        <section aria-label="Historial mensual">
          <h2 className="mb-2 text-sm font-semibold">Mes a mes</h2>
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm" data-testid="recall-client-history">
              <thead>
                <tr className="border-b border-kairikos-border text-left text-xs uppercase tracking-wide text-kairikos-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Mes</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Recuperadas</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Con recado</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Reseñas pedidas</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.localMonth} className="border-b border-kairikos-border last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal capitalize">
                      {monthLabel(row.localMonth)}
                    </th>
                    <td className="px-4 py-2 text-right tabular-nums">{row.calls}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.recordedCalls}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.reviewRequests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-label="Últimas llamadas">
        <h2 className="mb-2 text-sm font-semibold">Últimas llamadas</h2>
        {calls.length === 0 ? (
          <EmptyState
            title="Todavía no ha entrado ninguna llamada"
            description="Cuando alguien te llame y no puedas atender, aparecerá aquí y te llegará por WhatsApp."
          />
        ) : (
          <ul className="space-y-2" data-testid="recall-client-calls">
            {calls.map((call) => (
              <li
                key={call.id}
                className="card p-4"
                data-testid="recall-client-call-row"
                data-outcome={call.outcome}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium tabular-nums">
                    {call.withheld || !call.fromNumber ? 'Número oculto' : call.fromNumber}
                  </span>
                  <span className="text-xs text-kairikos-muted">{DATE_FORMAT.format(call.startedAt)}</span>
                </div>
                {call.transcript ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="recall-client-transcript">
                    {call.transcript}
                  </p>
                ) : null}
                <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-kairikos-muted">
                  <span>{OUTCOME_LABEL[call.outcome] ?? call.outcome}</span>
                  <span data-testid="recall-client-notify">{notifyLabel(call)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-kairikos-muted" data-testid="recall-client-retention">
        Guardamos el texto del recado, pero la grabación de audio se borra automáticamente a los{' '}
        {view.recordingRetentionDays} días.
      </p>
    </div>
  );
}
