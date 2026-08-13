import type { ChatbotStatusSummary, OnboardingStatus } from '@/types/portal';
import { MOCK_CHATBOT } from '@/lib/portal-data';

// =============================================================================
// KAIA-13744 — Admin client-detail ChatbotStatusCard data source.
//
// The admin operator view at `/admin/portal/[clientId]?tab=overview` renders
// a `<ChatbotStatusCard>` next to the read-only client summary. Before this
// helper, the page assembled the `summary` object inline and reached for
// `MOCK_CHATBOT.*` literals as the fallback even when a real `ChatbotClient`
// row had been loaded from the database. The card therefore always showed
// `spc_acme_corp`, 142 conversaciones, 8% fallback, 12% derivación regardless
// of which customer the operator was inspecting.
//
// This module owns the gating decision. The page does the Prisma read (it
// already does, because the rest of the operator summary comes from the same
// row); it then hands the values to `buildAdminClientChatbotStatus` which
// returns either:
//   * a real `ChatbotStatusSummary` derived from the DB row + the 7-day
//     outcome counts, when `isDatabaseConfigured && client !== null`
//   * the `MOCK_CHATBOT` fixture, when the dev-mock fallback is in effect
//     (`!isDatabaseConfigured`, e.g. local `next dev` without DATABASE_URL)
//
// The gating mirrors the `listAdminClients` pattern from KAIA-13680 /
// KAIA-13702 (see portal/src/lib/portal-data.ts:365).
//
// Why a separate helper instead of inlining the conditional in the page:
//   1. The page is a Next.js Server Component — calling it directly from a
//      vitest test would require booting Next. A pure function lets the
//      structural guardrail from KAIA-13745 cover the values without a
//      renderToStaticMarkup round-trip.
//   2. The fallback shape is the one the operator already sees in
//      `next dev`; keeping it in one place (this file) makes the
//      dev-mock surface auditable from a single grep.
// =============================================================================

/**
 * The DB row shape we need to surface real values. Caller is responsible
 * for selecting only these fields in the Prisma query — passing in the
 * full `chatbotClient` row would let future schema changes silently leak
 * into the rendered HTML.
 */
export interface AdminClientChatbotStatusClient {
  id: string;
  goLiveAt: string | null;
}

/**
 * Outcome counts for the trailing 7-day window. Caller derives these
 * from `chatbotConversation.outcome` (allowlist on the schema:
 * `resolved | escalated | abandoned | fallback | unknown`).
 *
 * Rates are computed by this helper so the page does not need to know
 * the formula. Empty window (`{ conversations: 0, fallback: 0, escalation: 0 }`)
 * yields `fallbackRate: 0` and `escalationRate: 0` — never a hardcoded
 * 8% / 12% mock value.
 */
export interface Last7DaysOutcomeCounts {
  conversations: number;
  fallback: number;
  escalation: number;
}

export interface BuildAdminClientChatbotStatusInput {
  isDatabaseConfigured: boolean;
  client: AdminClientChatbotStatusClient | null;
  // Required only on the real-data branch. The function falls back to a
  // zeroed count when the caller forgets to pass it under the real branch,
  // but that path is also typed-as-required by passing it explicitly.
  last7DaysCounts?: Last7DaysOutcomeCounts;
  /**
   * Total conversation count for the trailing-7-day window. When
   * `last7DaysCounts` is omitted the page-level `conversationCount` is
   * the source of truth and we surface it directly. The two values
   * are kept as separate parameters because the page already computes
   * `conversationCount` once for the activity loop and we want to avoid
   * a second full-table count query.
   */
  conversationCount?: number;
}

function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  const rate = numerator / denominator;
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return rate;
}

function deriveOnboardingStatus(
  client: AdminClientChatbotStatusClient,
): OnboardingStatus {
  // The admin page already runs the full state→onboardingStatus mapping
  // elsewhere. For the card we only need the binary live vs. in_progress
  // signal — anything with a `goLiveAt` is `live`, otherwise the bot has
  // not been promoted to production yet.
  return client.goLiveAt ? 'live' : 'in-progress';
}

export function buildAdminClientChatbotStatus(
  input: BuildAdminClientChatbotStatusInput,
): ChatbotStatusSummary {
  // KAIA-13744 — MOCK_CHATBOT is the dev-mock fallback. Only reach for it
  // when the DB is genuinely not configured (local `next dev` without
  // DATABASE_URL) OR the page failed to resolve a real row. Never when
  // `isDatabaseConfigured && client !== null` — that branch is the
  // production path and must render real values.
  if (!input.isDatabaseConfigured || !input.client) {
    return MOCK_CHATBOT;
  }

  const client = input.client;
  const counts = input.last7DaysCounts ?? { conversations: 0, fallback: 0, escalation: 0 };
  // Prefer the 7-day-window count when the caller supplied it; otherwise
  // surface the page-level total-conversation count (which may include
  // older conversations outside the window). Both are real values; the
  // caller picks the right one based on the query it ran.
  const conversationsLast7Days =
    input.last7DaysCounts !== undefined
      ? counts.conversations
      : input.conversationCount ?? 0;

  return {
    spaceId: `spc_${client.id}`,
    status: deriveOnboardingStatus(client),
    goLiveDate: client.goLiveAt,
    last7Days: {
      conversations: conversationsLast7Days,
      fallbackRate: safeRate(counts.fallback, counts.conversations),
      escalationRate: safeRate(counts.escalation, counts.conversations),
    },
  };
}
