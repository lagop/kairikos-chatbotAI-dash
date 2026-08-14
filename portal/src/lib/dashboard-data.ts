import 'server-only';
import { prisma, isDatabaseConfigured } from './prisma';
import { MOCK_CLIENT, MOCK_CHATBOT, MOCK_TIMELINE } from './portal-data';
import { loadClientProfileViaPortalApi } from './dashboard-fallback';
import { logError } from './observability';
import { notifyOperatorOfExecutionFailure } from './operator-notify';
import { getProductCatalog, type ProductCode } from './catalogs';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';
import type { ResolvedClient } from './portal-session';
import type { OnboardingTimelineRow } from '@/types/portal';

// =============================================================================
// WP-08 / WP-17 — one data function for the client-facing summary screen
// (rendered at /portal — see that page's own header comment for why /portal,
// not /portal/dashboard, is the real route), not three attempts spread
// across page components.
//
// Before WP-08, the page itself owned: the direct Prisma read, the
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
// WP-17 — generalizes `products` from a hardcoded chatbot-only array of
// one to a real per-ClientProduct card: state, wizard progress, whose
// turn it is, and a single CTA. Also folds in the CONFIRMADO audit
// finding — /portal (this function's only real caller now), the former
// /portal/status, and the former /portal/dashboard each computed
// fallbackRate/escalationRate independently (two of the three hardcoded
// them to 0, one fell back to the MOCK_CHATBOT 8%/12% fixture on any
// fetch hiccup), so the same client's chatbot card showed three
// different numbers depending which URL you loaded. Every one of those
// pages now renders exactly what this file computed — nowhere else
// recomputes fallback/escalation rates.
// =============================================================================

export type DashboardDataSource = 'prisma' | 'portal_api_fallback' | 'mock_dev';

/** Whose move it is on this product. `null` when no action is expected
 *  from either side right now (e.g. already live, or an operator
 *  override state like 'paused'). */
export type ProductTurn = 'client' | 'kairikos' | null;

export interface ProductActivityWindow {
  conversations: number;
  fallbackRate: number;
  escalationRate: number;
}

export interface ProductActivityMetrics {
  last7Days: ProductActivityWindow;
  previous7Days: ProductActivityWindow;
}

export interface ProductCardSummary {
  productCode: ProductCode;
  label: string;
  onboardingState: string;
  goLiveAt: string | null;
  /** 0-100, share of required wizard steps currently approved. `null`
   *  when the product has no wizard content yet (an empty WP-15
   *  catalog) — there is nothing to compute a percentage of. */
  progressPercent: number | null;
  turn: ProductTurn;
  ctaLabel: string;
  /** `null` when there is nothing actionable to link to right now. */
  ctaHref: string | null;
  timeline: OnboardingTimelineRow[];
  /** Only 'chatbot' has conversation activity today — other products'
   *  cards carry `null` here until their own product surfaces one. */
  activity: ProductActivityMetrics | null;
}

export interface DashboardData {
  source: DashboardDataSource;
  client: {
    id: string;
    name: string;
  };
  products: ProductCardSummary[];
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

function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

async function computeChatbotActivity(clientId: string): Promise<ProductActivityMetrics> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // WP-17 — this is the real fix for the CONFIRMADO audit finding:
  // fallbackRate/escalationRate computed from ChatbotConversation.outcome
  // (same formula chatbot-status.ts already uses on the operator side),
  // never a hardcoded 0 or the MOCK_CHATBOT 8%/12% fixture.
  const [current, previous] = await Promise.all([
    prisma.chatbotConversation.findMany({
      where: { clientId, startedAt: { gte: sevenDaysAgo } },
      select: { outcome: true },
    }),
    prisma.chatbotConversation.findMany({
      where: { clientId, startedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
      select: { outcome: true },
    }),
  ]);

  const windowOf = (rows: Array<{ outcome: string | null }>): ProductActivityWindow => ({
    conversations: rows.length,
    fallbackRate: safeRate(rows.filter((r) => r.outcome === 'fallback').length, rows.length),
    escalationRate: safeRate(rows.filter((r) => r.outcome === 'escalated').length, rows.length),
  });

  return { last7Days: windowOf(current), previous7Days: windowOf(previous) };
}

interface ClientProductRow {
  productCode: ProductCode;
  productLabel: string;
  onboardingState: string;
  goLiveAt: Date | null;
}

/** Resolve wizard progress + whose turn it is for one product, from its
 *  ChatbotConfigStep rows. Empty-catalog products (no wizard yet) skip
 *  this entirely — see buildProductCard. */
async function resolveWizardProgress(
  clientId: string,
  productCode: ProductCode,
  requiredStepKeys: readonly string[],
): Promise<{ progressPercent: number; turn: ProductTurn; ctaLabel: string; ctaHref: string | null }> {
  const rows = await prisma.chatbotConfigStep.findMany({
    where: { clientId, productCode },
    orderBy: [{ stepKey: 'asc' }, { version: 'desc' }],
    select: { stepKey: true, status: true, activeForBot: true },
  });
  const latestByStep = new Map<string, { status: string; activeForBot: boolean }>();
  for (const row of rows) {
    if (!latestByStep.has(row.stepKey)) latestByStep.set(row.stepKey, row);
  }

  const approvedCount = requiredStepKeys.filter((k) => latestByStep.get(k)?.activeForBot).length;
  const progressPercent = Math.round((approvedCount / requiredStepKeys.length) * 100);

  // A required step still blocks readiness if the client has never
  // submitted a version of it, or the latest version is a draft they
  // haven't sent for review yet. Anything 'submitted' or already
  // 'activeForBot' (approved) does NOT block — it's waiting on Kairikos.
  const firstUnsubmitted = requiredStepKeys.find((k) => {
    const latest = latestByStep.get(k);
    return !latest || latest.status === 'draft';
  });

  if (firstUnsubmitted) {
    const missingCount = requiredStepKeys.length - approvedCount;
    return {
      progressPercent,
      turn: 'client',
      ctaLabel: missingCount === 1 ? 'Completa 1 paso' : `Completa ${missingCount} pasos`,
      ctaHref: `/portal/wizard/${productCode}/${firstUnsubmitted}`,
    };
  }
  return {
    progressPercent,
    turn: 'kairikos',
    ctaLabel: 'En revisión de Kairikos',
    ctaHref: null,
  };
}

async function buildProductCard(clientId: string, cp: ClientProductRow): Promise<ProductCardSummary> {
  const catalog = getProductCatalog(cp.productCode);
  const goLiveAt = cp.goLiveAt?.toISOString() ?? null;
  const base = {
    productCode: cp.productCode,
    label: cp.productLabel || catalog.label,
    onboardingState: cp.onboardingState,
    goLiveAt,
  };

  // WP-15's other four catalogs are still empty — nothing to compute a
  // wizard percentage or a "your turn" signal against yet.
  if (catalog.requiredStepKeys.length === 0) {
    return {
      ...base,
      progressPercent: null,
      turn: null,
      ctaLabel: 'Próximamente',
      ctaHref: null,
      timeline: [],
      activity: null,
    };
  }

  const [progress, activityRows] = await Promise.all([
    // 'live'/'updating'/'go-live-pending'/'ready' each have a clearer
    // signal than "is a step still a draft" — only 'in-progress' needs
    // the step-by-step read.
    cp.onboardingState === 'in-progress'
      ? resolveWizardProgress(clientId, cp.productCode, catalog.requiredStepKeys)
      : Promise.resolve(null),
    prisma.chatbotActivity.findMany({
      where: { clientId, productCode: cp.productCode },
      orderBy: { completedAt: 'asc' },
    }),
  ]);

  let turn: ProductTurn;
  let ctaLabel: string;
  let ctaHref: string | null;
  let progressPercent: number | null;

  switch (cp.onboardingState) {
    case 'live':
      turn = null;
      ctaLabel = 'En producción';
      ctaHref = null;
      progressPercent = 100;
      break;
    case 'updating':
      turn = 'client';
      ctaLabel = 'Revisa el paso solicitado';
      ctaHref = `/portal/wizard/${cp.productCode}`;
      progressPercent = null;
      break;
    case 'go-live-pending':
      turn = 'kairikos';
      ctaLabel = 'Esperando confirmación de Kairikos';
      ctaHref = null;
      progressPercent = null;
      break;
    case 'ready':
      turn = 'client';
      ctaLabel = 'Solicitar salida a producción';
      ctaHref = '/portal/onboarding';
      progressPercent = 100;
      break;
    case 'in-progress':
      // WP-17 bug fix: `progress?.ctaHref ?? fallback` would silently
      // replace a legitimate `ctaHref: null` (the "kairikos turn, no
      // link" case) with the fallback wizard link — `??` can't tell
      // "field is null on purpose" apart from "the whole object is
      // missing". Branch on `progress` itself instead.
      if (progress) {
        turn = progress.turn;
        ctaLabel = progress.ctaLabel;
        ctaHref = progress.ctaHref;
        progressPercent = progress.progressPercent;
      } else {
        turn = 'client';
        ctaLabel = `Configura ${base.label}`;
        ctaHref = `/portal/wizard/${cp.productCode}`;
        progressPercent = 0;
      }
      break;
    default:
      // 'pending' | 'paused' | 'cancelled' | 'archived' | 'draft' —
      // operator-driven account-lifecycle overrides, not a wizard state.
      // Neither side has a wizard action to take right now.
      turn = null;
      ctaLabel = 'Contacta con soporte';
      ctaHref = '/portal/support';
      progressPercent = null;
  }

  return {
    ...base,
    progressPercent,
    turn,
    ctaLabel,
    ctaHref,
    timeline: toTimeline(activityRows),
    activity: cp.productCode === CHATBOT_PRODUCT_CODE ? await computeChatbotActivity(clientId) : null,
  };
}

async function buildRealProducts(clientId: string): Promise<ProductCardSummary[]> {
  const clientProducts = await prisma.clientProduct.findMany({
    where: { clientId, status: { in: ['active', 'paused'] } },
    orderBy: { subscribedAt: 'asc' },
    select: {
      onboardingState: true,
      goLiveAt: true,
      product: { select: { code: true, name: true } },
    },
  });
  return Promise.all(
    clientProducts.map((cp) =>
      buildProductCard(clientId, {
        productCode: cp.product.code as ProductCode,
        productLabel: cp.product.name,
        onboardingState: cp.onboardingState,
        goLiveAt: cp.goLiveAt,
      }),
    ),
  );
}

function mockChatbotCard(): ProductCardSummary {
  return {
    productCode: CHATBOT_PRODUCT_CODE,
    label: getProductCatalog(CHATBOT_PRODUCT_CODE).label,
    onboardingState: MOCK_CHATBOT.status,
    goLiveAt: MOCK_CHATBOT.goLiveDate,
    progressPercent: MOCK_CHATBOT.status === 'live' ? 100 : 50,
    turn: MOCK_CHATBOT.status === 'live' ? null : 'client',
    ctaLabel: MOCK_CHATBOT.status === 'live' ? 'En producción' : 'Continuar configuración',
    ctaHref: MOCK_CHATBOT.status === 'live' ? null : `/portal/wizard/${CHATBOT_PRODUCT_CODE}`,
    timeline: MOCK_TIMELINE,
    activity: {
      last7Days: MOCK_CHATBOT.last7Days,
      previous7Days: { conversations: 0, fallbackRate: 0, escalationRate: 0 },
    },
  };
}

/**
 * Resolves everything the client-facing summary screen needs to render,
 * in one call. Never throws — every failure path degrades to the next
 * data source (Prisma → the /api/portal/me fallback → the dev-mock
 * fixture) and is logged; the two-sources-failed case also alerts the
 * operator, since at that point a real customer is about to see
 * MOCK_CLIENT.
 */
export async function getDashboardData(resolved: ResolvedClient): Promise<DashboardData> {
  // KAIA-11955: a real customer with zero activity rows must NOT see
  // MOCK_TIMELINE (the Acme 4-step fixture) — only genuine dev-mock (no
  // DB configured at all) gets the fixture, straight away, no fetch.
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return {
      source: 'mock_dev',
      client: { id: MOCK_CLIENT.id, name: MOCK_CLIENT.companyName },
      products: [mockChatbotCard()],
    };
  }

  let clientName = MOCK_CLIENT.companyName;
  let products: ProductCardSummary[] = [];
  let source: DashboardDataSource = 'mock_dev';
  let prismaError: unknown = null;

  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { companyName: true, name: true },
    });

    if (client) {
      clientName = client.companyName ?? client.name;
      source = 'prisma';
    } else {
      logError(
        'dashboard.client_not_found',
        new Error('prisma.chatbotClient.findUnique returned null for a resolved clientId'),
        { route: '/portal', clientId: resolved.clientId, clientEmail: resolved.email },
        'warn',
      );
    }

    // WP-17 — split out of the try above (same reasoning as the old
    // WP-08 activities-query isolation): a schema-drift failure while
    // building the product cards must not take down the client's own
    // name/heading, which the simpler chatbotClient read above already
    // resolved successfully.
    try {
      products = await buildRealProducts(resolved.clientId);
    } catch (productsErr) {
      logError(
        'dashboard.products_build_failed',
        productsErr,
        { route: '/portal', clientId: resolved.clientId, clientEmail: resolved.email },
        'warn',
      );
    }
  } catch (err) {
    prismaError = err;
    logError('dashboard.prisma_fetch', err, {
      route: '/portal',
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
  // point. Products can't be resolved on this path (no ClientProduct
  // access without Prisma) — the client still gets their own name and a
  // single chatbot card with no progress/turn signal, rather than a
  // fully mocked page.
  if (source !== 'prisma') {
    const profile = await loadClientProfileViaPortalApi();
    if (profile) {
      const fallbackName = profile.companyName ?? profile.contactName ?? '';
      if (fallbackName) {
        clientName = fallbackName;
      }
      source = 'portal_api_fallback';
      products = [
        {
          productCode: CHATBOT_PRODUCT_CODE,
          label: getProductCatalog(CHATBOT_PRODUCT_CODE).label,
          onboardingState: profile.goLiveDate ? 'live' : 'in-progress',
          goLiveAt: profile.goLiveDate ?? null,
          progressPercent: null,
          turn: null,
          ctaLabel: 'Ver detalle',
          ctaHref: '/portal/status',
          timeline: [],
          activity: null,
        },
      ];
    } else if (prismaError) {
      // Both data sources failed — the customer is about to see
      // MOCK_CLIENT ("Acme Corp") instead of their own data, the exact
      // incident shape of KAIA-11329/11641/11955. Alert, not just log.
      logError('dashboard.both_sources_failed', prismaError, {
        route: '/portal',
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
    client: { id: resolved.clientId, name: clientName },
    products,
  };
}
