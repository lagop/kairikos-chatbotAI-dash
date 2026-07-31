import 'server-only';

const ANALYTICS_ENDPOINT = process.env.PORTAL_ANALYTICS_ENDPOINT ?? '';
const ANALYTICS_SITE_ID = process.env.PORTAL_ANALYTICS_SITE_ID ?? 'kairikos-portal';

export interface PageViewEvent {
  path: string;
  referrer: string | null;
  userId: string | null;
  locale: string;
  title: string | null;
}

// =============================================================================
// KAIA-4263 — Self-serve onboarding funnel events.
//
// Funnel events flow through the same /api/portal/track endpoint that
// receives page_views and assets-uploaded, but with type='onboarding_event'.
// We persist them to a local `onboarding_funnel_events` table so the
// owner-facing view at /admin/portal/onboarding-funnel can show
// signup → product → config → pago → activado drop-off without
// shipping every event to a third-party analytics provider. The
// `PORTAL_ANALYTICS_ENDPOINT` upstream still receives the same JSON
// so existing dashboards keep working.
// =============================================================================
export interface OnboardingFunnelEvent {
  event:
    | 'step_seen'
    | 'step_completed'
    | 'signup'
    | 'product_selected'
    | 'config_saved'
    | 'checkout_started'
    | 'activated'
    | 'abandoned';
  step?: string;
  reason?: string;
  sessionId: string;
  path: string;
  ts: string;
}

export async function trackPageView(event: PageViewEvent): Promise<void> {
  if (!ANALYTICS_ENDPOINT) return;
  try {
    await fetch(ANALYTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'page_view',
        site: ANALYTICS_SITE_ID,
        ...event,
        ts: new Date().toISOString(),
      }),
      keepalive: true,
    });
  } catch {
    // analytics must never break the page
  }
}

export async function trackOnboardingEvent(event: OnboardingFunnelEvent): Promise<void> {
  if (ANALYTICS_ENDPOINT) {
    try {
      await fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'onboarding_event',
          site: ANALYTICS_SITE_ID,
          ...event,
        }),
        keepalive: true,
      });
    } catch {
      // fall through to local persistence
    }
  }
  // Local persistence is the responsibility of /api/portal/track.
}

