import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { EmptyState } from '@/components/portal/EmptyState';
import { GoogleReviewsPanel, type ConnectionStatus } from '@/components/portal/GoogleReviewsPanel';
import { ReviewCampaignsPanel, type CampaignSummary } from '@/components/portal/ReviewCampaignsPanel';
import { ReviewReplyControls } from '@/components/portal/ReviewReplyControls';

export const dynamic = 'force-dynamic';

// KAIA-11956 — this metadata is pinned by tests/unit/portal-resenas-surface.test.ts
// as a literal string, and stays static (not product-gated) on purpose:
// making it a real generateMetadata() lookup for the rare
// contracted-and-connected case isn't worth the risk of touching this
// pinned surface for a product ('reviews') that isn't sellable yet — see
// WP-22a's PR description.
export const metadata: Metadata = {
  title: 'Reseñas · No disponible en tu plan',
  description:
    'La gestión de reseñas de Google no está incluida en tu plan actual de Kairikos. Te contamos qué opciones tienes para habilitarla.',
  alternates: { canonical: '/portal/resenas' },
  robots: { index: false, follow: false },
};

const STAR_ICON = (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9 6-.9L12 3.5z" />
  </svg>
);

// KAIA-11956 — every string in this component is pinned verbatim by the
// regression test (title, "Función no disponible", the two data-testids)
// and the test also asserts this whole file's source never regresses to
// a "coming soon"-style promise. Do not edit without re-reading that
// test first.
function ResenasUnavailable() {
  return (
    <div
      className="space-y-6"
      data-testid="portal-resenas-unavailable"
    >
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">
          Reseñas
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Las reseñas de Google no están incluidas en tu plan actual
        </h1>
        <p className="max-w-2xl text-sm text-kairikos-muted">
          Esta sección del portal no está activa para tu cuenta. No verás datos
          de reseñas aquí hasta que la gestión de reseñas forme parte del plan
          que tengas contratado.
        </p>
      </header>

      <section
        className="card flex flex-col items-center gap-5 py-12 text-center"
        aria-label="Reseñas de Google no disponibles en este plan"
      >
        <span
          aria-hidden
          className="grid h-16 w-16 place-items-center rounded-2xl border border-kairikos-border bg-kairikos-surface2 text-kairikos-muted"
        >
          {STAR_ICON}
        </span>
        <div className="space-y-2">
          <p className="text-base font-semibold">Función no disponible</p>
          <p className="mx-auto max-w-md text-sm text-kairikos-muted">
            Si quieres usar la gestión de reseñas de Google con Kairikos,
            escríbenos y te contamos las opciones para añadirla a tu cuenta.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/portal/support"
            className="btn-primary"
            data-testid="resenas-contact-support"
          >
            Hablar con soporte
          </Link>
          <Link
            href="/portal"
            className="btn-ghost"
            data-testid="resenas-back-to-dashboard"
          >
            Volver al inicio
          </Link>
        </div>
      </section>
    </div>
  );
}

const STAR_FULL = '★';
const STAR_EMPTY = '☆';

function StarRating({ value }: { value: number }) {
  const stars = STAR_FULL.repeat(Math.max(0, Math.min(5, value))) + STAR_EMPTY.repeat(5 - Math.max(0, Math.min(5, value)));
  return (
    <span className="text-kairikos-warning" aria-label={`${value} de 5 estrellas`}>
      {stars}
    </span>
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

interface PageProps {
  searchParams: { connected?: string; connect_error?: string };
}

const CONNECT_ERROR_LABEL: Record<string, string> = {
  csrf: 'No se pudo verificar la solicitud — inténtalo de nuevo.',
  token_exchange_failed: 'Google no pudo completar la conexión — inténtalo de nuevo.',
  no_locations: 'No encontramos ninguna ficha de Google Business Profile accesible con esa cuenta.',
  multiple_locations_unsupported: 'Tu cuenta de Google tiene más de una ficha y todavía no podemos elegir cuál conectar. Escríbenos a soporte.',
  no_tenant: 'No pudimos completar la conexión — escríbenos a soporte.',
  not_configured: 'La conexión con Google no está disponible en este momento.',
  not_available_in_dev_mode: 'La conexión con Google no está disponible en modo demo.',
  forbidden: 'Este producto no está incluido en tu plan.',
};

export default async function PortalResenasPage({ searchParams }: PageProps) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/resenas');
  }

  const hasReviews =
    isDatabaseConfigured && resolved.source === 'database'
      ? await isProductContracted(prisma, resolved.clientId, 'reviews')
      : false;

  if (!hasReviews) {
    return <ResenasUnavailable />;
  }

  const connection = await prisma.googleBusinessConnection.findFirst({
    where: { clientId: resolved.clientId },
    orderBy: { connectedAt: 'desc' },
  });

  const reviews =
    connection && connection.status !== 'revoked'
      ? await prisma.googleReview.findMany({
          where: { clientId: resolved.clientId },
          orderBy: { createTime: 'desc' },
          take: 50,
        })
      : [];

  const connectionStatus: ConnectionStatus = connection
    ? (connection.status as ConnectionStatus)
    : 'not_connected';

  const campaigns: CampaignSummary[] =
    connectionStatus === 'active'
      ? (
          await prisma.reviewRequestCampaign.findMany({
            where: { clientId: resolved.clientId },
            orderBy: { createdAt: 'desc' },
            include: { requests: { select: { status: true, clickedAt: true } } },
          })
        ).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          createdAt: c.createdAt.toISOString(),
          totalRequests: c.requests.length,
          sent: c.requests.filter((r) => r.status === 'sent').length,
          failed: c.requests.filter((r) => r.status === 'failed').length,
          clicked: c.requests.filter((r) => r.clickedAt !== null).length,
        }))
      : [];

  return (
    <div className="space-y-6" data-testid="portal-resenas-connected">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">Reseñas</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Reseñas de Google</h1>
        <p className="max-w-2xl text-sm text-kairikos-muted">
          Consulta las reseñas de tu ficha de Google Business Profile desde aquí.
        </p>
      </header>

      {searchParams.connected === '1' ? (
        <div
          role="status"
          data-testid="google-reviews-connected-banner"
          className="rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success"
        >
          Cuenta de Google conectada.
        </div>
      ) : null}
      {searchParams.connect_error ? (
        <div
          role="alert"
          data-testid="google-reviews-connect-error-banner"
          className="rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger"
        >
          {CONNECT_ERROR_LABEL[searchParams.connect_error] ?? 'No se pudo completar la conexión con Google.'}
        </div>
      ) : null}

      <GoogleReviewsPanel
        connectionId={connection?.id ?? null}
        status={connectionStatus}
        locationName={connection?.locationName ?? null}
        lastSyncAt={connection?.lastSyncAt?.toISOString() ?? null}
        lastSyncError={connection?.lastSyncError ?? null}
        autoPublishReplies={connection?.autoPublishReplies ?? false}
        autoPublishRepliesChangedAt={connection?.autoPublishRepliesChangedAt?.toISOString() ?? null}
      />

      {connectionStatus === 'active' ? (
        <section className="space-y-3" aria-label="Lista de reseñas" data-testid="google-reviews-list">
          {reviews.length === 0 ? (
            <EmptyState
              title="Sin reseñas todavía"
              description="En cuanto tu ficha reciba reseñas en Google, aparecerán aquí tras la próxima sincronización."
            />
          ) : (
            reviews.map((review) => (
              <div key={review.id} className="card" data-testid="google-review-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StarRating value={review.starRating} />
                    <span className="text-sm font-semibold">{review.reviewerName ?? 'Anónimo'}</span>
                  </div>
                  <span className="text-xs text-kairikos-muted">{DATE_FORMAT.format(review.createTime)}</span>
                </div>
                {review.comment ? <p className="mt-2 text-sm text-kairikos-muted">{review.comment}</p> : null}
                {review.replyComment ? (
                  <div className="mt-3 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3 text-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">Tu respuesta</p>
                    <p className="mt-1">{review.replyComment}</p>
                  </div>
                ) : (
                  <ReviewReplyControls reviewId={review.id} initialDraft={review.aiDraftReply} />
                )}
              </div>
            ))
          )}
        </section>
      ) : null}

      {connectionStatus === 'active' ? <ReviewCampaignsPanel campaigns={campaigns} /> : null}
    </div>
  );
}
