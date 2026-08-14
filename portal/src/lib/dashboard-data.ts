import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { MOCK_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from './portal-data';
import { loadClientProfileViaPortalApi } from './dashboard-fallback';
import { logError } from './observability';
import { notifyOperatorOfExecutionFailure } from './operator-notify';
import type { ResolvedClient } from './portal-session';
import type { ChatbotStatusSummary, OnboardingTimelineRow } from '@/types/portal';

// =============================================================================
// WP-08 — one data function for /portal/dashboard, not three attempts
// spread across the page component.
//
// Before this, the page itself owned: the direct Prisma read, the
// KAIA-11641 /api/portal/me fallback for when Prisma is broken, AND the
// dev-mock MOCK_CLIENT default — three separate "where does the data come
// from" decisions interleaved with JSX. That shape already produced three
// real incidents (KAIA-11329, -11641, -11955) where a signed-in customer
// saw "Acme Corp" instead of their own company. Moving all of it here
// means the page can't make a mock-vs-real decision anymore — it only
// renders whatever this function decided, and the `source` field on the
// result tells it (and, per the WP-08 AC, the diagnostic banner) which
// path fired.
//
// `products: ClientProductSummary[]` is deliberately an array of one
// today (product: 'chatbot' is the only member of the union) — Fase 3
// adds more products per client, and this is the seam where that grows
// instead of a page-level rewrite.
// =============================================================================

export type DashboardDataSource = 'prisma' | 'portal_api_fallback' | 'mock_dev';

export interface ClientProductSummary {
  product: 'chatbot';
  summary: ChatbotStatusSummary;
}

export interface DashboardData {
  source: DashboardDataSource;
  client: {
    id: string;
    name: string;
    goLiveAt: string | null;
  };
  products: ClientProductSummary[];
  timeline: OnboardingTimelineRow[];
}

const MILESTONE_LABEL: Record<string, string> = {
  'T+0': 'Bienvenida y acceso al portal',
  'T+3': 'Configuración inicial',
  'T+7': 'Puesta en producción',
  'T+14': 'Revisión y optimización',
};

const MILESTONE_STEP: Record<string, 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};

interface ActivityRow {
  id: string;
  milestone: string;
  notes: string | null;
  completedAt: Date | null;
}

function toTimeline(activities: ActivityRow[]): OnboardingTimelineRow[] {
  if (activities.length === 0) return [];
  const firstPendingIndex = activities.findIndex((a) => !a.completedAt);
  return activities.map((a, i) => ({
    id: a.id,
    step: MILESTONE_STEP[a.milestone] ?? 't_plus_0',
    label: MILESTONE_LABEL[a.milestone] ?? a.milestone,
    description: a.notes ?? '',
    occurredAt: a.completedAt?.toISOString() ?? null,
    status: a.completedAt ? 'done' : i === firstPendingIndex ? 'current' : 'pending',
  }));
}

function buildProducts(clientId: string, goLiveAt: string | null, conversationCount: number): ClientProductSummary[] {
  const summary: ChatbotStatusSummary = {
    spaceId: `spc_${clientId}`,
    status: goLiveAt ? 'live' : 'in-progress',
    goLiveDate: goLiveAt,
    last7Days: { conversations: conversationCount, fallbackRate: 0, escalationRate: 0 },
  };
  return [{ product: 'chatbot', summary }];
}

/**
 * Resolves everything /portal/dashboard needs to render, in one call.
 * Never throws — every failure path degrades to the next data source
 * (Prisma → the /api/portal/me fallback → the dev-mock fixture) and is
 * logged; the two-sources-failed case also alerts the operator, since at
 * that point a real customer is about to see MOCK_CLIENT.
 */
export async function getDashboardData(resolved: ResolvedClient): Promise<DashboardData> {
  // KAIA-11955: a real customer with zero activity rows must NOT see
  // MOCK_TIMELINE (the Acme 4-step fixture) — only genuine dev-mock (no
  // DB configured at all) gets the fixture, straight away, no fetch.
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return {
      source: 'mock_dev',
      client: { id: MOCK_CLIENT.id, name: MOCK_CLIENT.companyName, goLiveAt: MOCK_CLIENT.goLiveDate },
      products: [{ product: 'chatbot', summary: MOCK_CHATBOT }],
      timeline: MOCK_TIMELINE,
    };
  }

  let clientName = MOCK_CLIENT.companyName;
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline: OnboardingTimelineRow[] = [];
  let source: DashboardDataSource = 'mock_dev';
  let prismaError: unknown = null;

  try {
    // KAIA-11932 — the activities query is split out of this Promise.all
    // deliberately: chatbotActivity.findMany has been observed to throw on
    // production DBs that pre-date the tenant_id column, and bundling it
    // in would surface that failure even when chatbotClient.findUnique
    // (the authoritative source for the heading) would otherwise succeed.
    const [client, count] = await Promise.all([
      prisma.chatbotClient.findUnique({
        where: { id: resolved.clientId },
        select: { companyName: true, name: true, goLiveAt: true },
      }),
      prisma.chatbotConversation.count({ where: { clientId: resolved.clientId } }),
    ]);

    let activities: ActivityRow[] = [];
    try {
      activities = await prisma.chatbotActivity.findMany({
        where: { clientId: resolved.clientId },
        orderBy: { completedAt: 'asc' },
      });
    } catch (activitiesErr) {
      logError(
        'dashboard.activities_find_many',
        activitiesErr,
        { route: '/portal/dashboard', clientId: resolved.clientId, clientEmail: resolved.email },
        'warn',
      );
    }

    if (client) {
      clientName = client.companyName ?? client.name;
      goLiveAt = client.goLiveAt?.toISOString() ?? null;
      source = 'prisma';
    } else {
      logError(
        'dashboard.client_not_found',
        new Error('prisma.chatbotClient.findUnique returned null for a resolved clientId'),
        { route: '/portal/dashboard', clientId: resolved.clientId, clientEmail: resolved.email },
        'warn',
      );
    }
    conversationCount = count;
    timeline = toTimeline(activities);
  } catch (err) {
    prismaError = err;
    logError('dashboard.prisma_fetch', err, {
      route: '/portal/dashboard',
      clientId: resolved.clientId,
      clientEmail: resolved.email,
    });
  }

  // KAIA-11641: when Prisma is broken, route through the same
  // /api/portal/me source that returns the real customer data — /me uses
  // the same chatbotClient.findUnique shape but has been observed to
  // succeed where the direct call does not (most likely a schema-drift /
  // relationMode miss). This preserves "real customer data, not
  // MOCK_CLIENT" even when the underlying Prisma query is the failure
  // point.
  if (source !== 'prisma') {
    const profile = await loadClientProfileViaPortalApi();
    if (profile) {
      const fallbackName = profile.companyName ?? profile.contactName ?? '';
      if (fallbackName) {
        clientName = fallbackName;
        goLiveAt = profile.goLiveDate ?? null;
      }
      source = 'portal_api_fallback';
    } else if (prismaError) {
      // Both data sources failed — the customer is about to see
      // MOCK_CLIENT ("Acme Corp") instead of their own data, the exact
      // incident shape of KAIA-11329/11641/11955. Alert, not just log.
      logError('dashboard.both_sources_failed', prismaError, {
        route: '/portal/dashboard',
        clientId: resolved.clientId,
        clientEmail: resolved.email,
      });
      void notifyOperatorOfExecutionFailure({
        executionId: `dashboard-${resolved.clientId}-${Date.now()}`,
        workflowName: 'portal_dashboard_data_resolution',
        error: prismaError instanceof Error ? prismaError.message : String(prismaError),
        clientId: resolved.clientId,
        // clientName is still the MOCK_CLIENT placeholder at this point
        // (both real sources failed) — not useful to the operator, so
        // the email goes in its place; the template surfaces it verbatim.
        clientName: resolved.email,
      }).catch(() => {
        // Best-effort — the logError call above already guarantees this
        // path isn't silent even if the alert itself doesn't send.
      });
    }
  }

  return {
    source,
    client: { id: resolved.clientId, name: clientName, goLiveAt },
    products: buildProducts(resolved.clientId, goLiveAt, conversationCount),
    timeline,
  };
}
