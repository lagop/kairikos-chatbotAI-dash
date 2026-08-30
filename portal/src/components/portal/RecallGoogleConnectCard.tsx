// =============================================================================
// WP-XX — recall's own entry point to connect a Google Business Profile.
//
// Fixes the bug where RecallSubscription.googleConnectionId could never
// be set for a recall-only client: the OAuth mechanism (google-business.ts)
// and the review-sending code (recall-reviews.ts) both already existed,
// but the ONLY UI that started that OAuth flow lived on /portal/resenas,
// gated on the separate standalone 'reviews' product. This card gives
// recall clients the same flow from their own page — see the OAuth start
// route's `hasGoogleBusinessConnectAccess` check and the callback route's
// auto-bind onto an active RecallSubscription.
//
// A plain link, not a component with its own fetch/state like
// GoogleReviewsPanel: that one also handles sync/disconnect/auto-publish,
// none of which apply here — recall never disconnects (same reasoning
// as RecallMetaConnectCard's header), and syncing/replying to reviews is
// the standalone 'reviews' product's job, not recall's. Recall only
// needs the connection to exist so requestReviewsFor() can use it.
// =============================================================================

const OAUTH_START_HREF = '/api/portal/google-business/oauth/start?from=llamadas';

export interface RecallGoogleConnection {
  locationName: string;
  status: string;
}

export function RecallGoogleConnectCard({ connection }: { connection: RecallGoogleConnection | null }) {
  if (connection?.status === 'active') {
    return (
      <div className="card space-y-1" data-testid="recall-google-connect-card" data-connected="true">
        <h3 className="text-sm font-semibold">Google Business conectado</h3>
        <p className="text-sm text-kairikos-muted">
          {connection.locationName} — así podemos pedir la reseña cuando respondes al resumen de WhatsApp.
        </p>
      </div>
    );
  }

  if (connection?.status === 'needs_reconnect') {
    return (
      <div className="card space-y-3" data-testid="recall-google-connect-card" data-connected="false">
        <div className="rounded-xl border border-kairikos-warning/40 bg-kairikos-warning/10 px-4 py-3 text-sm">
          <p className="font-semibold">Reconexión necesaria</p>
          <p className="mt-1 text-kairikos-muted">
            Google ha revocado el acceso a {connection.locationName}. Reconecta para seguir pidiendo reseñas.
          </p>
        </div>
        <a href={OAUTH_START_HREF} className="btn-primary" data-testid="recall-google-connect-button">
          Reconectar con Google
        </a>
      </div>
    );
  }

  return (
    <div className="card space-y-3" data-testid="recall-google-connect-card" data-connected="false">
      <div>
        <h3 className="text-sm font-semibold">Conectar Google Business</h3>
        <p className="mt-1 text-sm text-kairikos-muted">
          Sin esto no podemos pedir la reseña en Google cuando respondes al resumen de WhatsApp.
        </p>
      </div>
      <a href={OAUTH_START_HREF} className="btn-primary" data-testid="recall-google-connect-button">
        Conectar con Google
      </a>
    </div>
  );
}
