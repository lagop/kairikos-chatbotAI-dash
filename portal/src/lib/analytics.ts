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
