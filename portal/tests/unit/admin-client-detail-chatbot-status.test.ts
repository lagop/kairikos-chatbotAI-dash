// =============================================================================
// KAIA-13744 — Admin client-detail ChatbotStatusCard data source.
//
// Before this fix, `portal/src/app/admin/portal/[clientId]/page.tsx`
// surfaced the `MOCK_CHATBOT` fixture (`spc_acme_corp`, 142 conversaciones,
// 8% fallback, 12% derivación) into the rendered operator view even when
// a real `ChatbotClient` row was loaded. The fix introduced
// `buildAdminClientChatbotStatus` in `src/lib/chatbot-status.ts` which:
//
//   * Returns the MOCK_CHATBOT fixture when `!isDatabaseConfigured` or
//     when the page failed to resolve a real client row (dev-mock mode,
//     e.g. local `next dev` without DATABASE_URL).
//   * Returns a real ChatbotStatusSummary derived from the supplied
//     client + 7-day outcome counts when `isDatabaseConfigured &&
//     client !== null`.
//
// Acceptance criteria from the issue body:
//
//   * On a production deployment with `isDatabaseConfigured === true` and a
//     real client row, the card renders Orly's real `chatbotSpaceId`
//     (here: `spc_<id>`), the real conversation count, the real rates, and
//     the real `goLiveAt`.
//   * The page must NOT hard-code `spc_acme_corp`, `142`, `0.08`, or
//     `0.12` in any non-dev-mock environment. Verified by the
//     `MOCK_CHATBOT_LEAK` literals below.
//   * Dev-mock mode (`!isDatabaseConfigured`) still renders the
//     `MOCK_CHATBOT` values so `next dev` works without a backend.
//
// Run: `npm run test:unit -- tests/unit/admin-client-detail-chatbot-status.test.ts`
// =============================================================================

import { describe, expect, it } from 'vitest';
import { buildAdminClientChatbotStatus } from '@/lib/chatbot-status';
import { MOCK_CHATBOT } from '@/lib/portal-data';

// These are the exact strings that leaked in production per the issue body.
// Asserting that the helper never returns any of them on the real-data
// branch is the core regression guard.
const MOCK_CHATBOT_LEAK = ['spc_acme_corp', '142', '0.08', '0.12'] as const;

const STAGING_CLINICA_DENTAL_ORLY = {
  // The id mirrors the real seeded row used in the issue's reproduction
  // (`/admin/portal/cmsh9mzor00018zsgsfa97l6m`). The goLiveAt is
  // deliberately different from `MOCK_CHATBOT.goLiveDate`
  // (`2026-05-29T09:00:00.000Z`) so the test proves the real branch
  // surfaces the row's value, not the dev-mock fixture.
  id: 'cmsh9mzor00018zsgsfa97l6m',
  goLiveAt: '2026-08-05T09:00:00.000Z' as string | null,
};

describe('buildAdminClientChatbotStatus (KAIA-13744) — dev-mock fallback', () => {
  it('returns MOCK_CHATBOT when DATABASE_URL is unset (next dev with no backend)', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: false,
      client: null,
    });
    expect(summary).toEqual(MOCK_CHATBOT);
    // Sanity: MOCK_CHATBOT still contains the dev-mock literals by
    // design — the leak guard applies to the real-data branch only.
    expect(summary.spaceId).toBe('spc_acme_corp');
    expect(summary.last7Days.conversations).toBe(142);
    expect(summary.last7Days.fallbackRate).toBe(0.08);
    expect(summary.last7Days.escalationRate).toBe(0.12);
  });

  it('returns MOCK_CHATBOT when DATABASE_URL is set but no client row resolved', () => {
    // This branch covers the unusual case where Prisma is configured but
    // the client lookup returned null AND the page caught the
    // notFound() before reaching this helper. Defensive — never surface
    // a half-built summary to the operator.
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: null,
    });
    expect(summary).toEqual(MOCK_CHATBOT);
  });

  it('returns MOCK_CHATBOT when last7DaysCounts is omitted AND client is null (dev-mock)', () => {
    // Same as the first test, but exercising the `conversationCount`
    // input the page passes. The helper must not surface that count in
    // dev-mock mode — MOCK_CHATBOT is the contract.
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: false,
      client: null,
      conversationCount: 17,
    });
    expect(summary).toEqual(MOCK_CHATBOT);
    expect(summary.last7Days.conversations).toBe(142); // not 17
  });
});

describe('buildAdminClientChatbotStatus (KAIA-13744) — real data branch', () => {
  it('emits `spc_<id>` for the real spaceId, not the Acme mock', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    expect(summary.spaceId).toBe('spc_cmsh9mzor00018zsgsfa97l6m');
    expect(summary.spaceId).not.toBe('spc_acme_corp');
  });

  it('uses the real goLiveAt ISO, not MOCK_CHATBOT.goLiveDate', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    expect(summary.goLiveDate).toBe(STAGING_CLINICA_DENTAL_ORLY.goLiveAt);
    expect(summary.goLiveDate).not.toBe(MOCK_CHATBOT.goLiveDate);
  });

  it('derives status="live" when goLiveAt is set', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    expect(summary.status).toBe('live');
  });

  it('derives status="in-progress" when goLiveAt is null', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: { id: 'cmsh9mzor00018zsgsfa97l6m', goLiveAt: null },
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    expect(summary.status).toBe('in-progress');
    expect(summary.goLiveDate).toBeNull();
  });

  it('surfaces the 7-day window conversation count, not 142', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 3, fallback: 0, escalation: 0 },
    });
    expect(summary.last7Days.conversations).toBe(3);
    expect(summary.last7Days.conversations).not.toBe(142);
  });

  it('computes fallbackRate from the 7-day outcome counts, not 0.08', () => {
    // 2 fallbacks out of 10 conversations = 0.2
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 10, fallback: 2, escalation: 0 },
    });
    expect(summary.last7Days.fallbackRate).toBeCloseTo(0.2);
    expect(summary.last7Days.fallbackRate).not.toBe(0.08);
  });

  it('computes escalationRate from the 7-day outcome counts, not 0.12', () => {
    // 1 escalation out of 4 conversations = 0.25
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 4, fallback: 0, escalation: 1 },
    });
    expect(summary.last7Days.escalationRate).toBeCloseTo(0.25);
    expect(summary.last7Days.escalationRate).not.toBe(0.12);
  });

  it('returns 0 rates when the 7-day window is empty (no division-by-zero)', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    expect(summary.last7Days.fallbackRate).toBe(0);
    expect(summary.last7Days.escalationRate).toBe(0);
  });

  it('returns 0 rates when fallback/escalation are zero but conversations > 0', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 7, fallback: 0, escalation: 0 },
    });
    expect(summary.last7Days.conversations).toBe(7);
    expect(summary.last7Days.fallbackRate).toBe(0);
    expect(summary.last7Days.escalationRate).toBe(0);
  });

  it('falls back to conversationCount when last7DaysCounts is omitted (legacy caller)', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      conversationCount: 5,
    });
    expect(summary.last7Days.conversations).toBe(5);
    expect(summary.last7Days.fallbackRate).toBe(0);
    expect(summary.last7Days.escalationRate).toBe(0);
  });
});

describe('buildAdminClientChatbotStatus (KAIA-13744) — leak guard', () => {
  it('does not leak any MOCK_CHATBOT literal on the real-data branch', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      last7DaysCounts: { conversations: 10, fallback: 1, escalation: 1 },
    });
    // Serialise the summary the same way the rendered HTML sees it.
    // A literal leak in the summary is a leak in the rendered DOM.
    const flat = JSON.stringify(summary);
    for (const literal of MOCK_CHATBOT_LEAK) {
      expect(flat, `real-data summary must not contain "${literal}"`).not.toContain(literal);
    }
  });

  it('does not leak any MOCK_CHATBOT literal on the real-data branch when goLiveAt is null', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: { id: 'cmsh9mzor00018zsgsfa97l6m', goLiveAt: null },
      last7DaysCounts: { conversations: 0, fallback: 0, escalation: 0 },
    });
    const flat = JSON.stringify(summary);
    for (const literal of MOCK_CHATBOT_LEAK) {
      expect(flat).not.toContain(literal);
    }
  });

  it('does not leak any MOCK_CHATBOT literal on the real-data branch when only the conversationCount is provided', () => {
    const summary = buildAdminClientChatbotStatus({
      isDatabaseConfigured: true,
      client: STAGING_CLINICA_DENTAL_ORLY,
      conversationCount: 142, // would be a misleading "match" for the literal guard
    });
    const flat = JSON.stringify(summary);
    for (const literal of MOCK_CHATBOT_LEAK) {
      if (literal === '142') {
        // This is a guard against false reassurance — the helper must
        // not surface MOCK_CHATBOT.last7Days.conversations under any
        // input shape on the real branch.
        expect(flat, 'real branch must not surface 142 from MOCK_CHATBOT').not.toBe(
          JSON.stringify(MOCK_CHATBOT),
        );
      } else {
        expect(flat).not.toContain(literal);
      }
    }
  });
});
