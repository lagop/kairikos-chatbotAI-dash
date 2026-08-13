import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { listStepsForClient, buildSavedStateMap } from '@/lib/wizard-visibility';
import {
  readLatestStepsForClient,
} from '@/lib/wizard-tier-prisma';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';

// =============================================================================
// KAIA-1166 (BE-4) — Cliente-facing tier-filtered wizard step list.
//
//   GET /api/portal/wizard/steps
//
// Returns the 12-step catalog annotated with the cliente's tier-derived
// visibility, plus per-step saved state. Steps 3 and 7 are hidden for
// Starter; Step 12 is hidden for every tier (v1.1 deferred). The route
// is the entry point the wizard shell uses to render the 3-block
// progress bar + the per-step list.
//
// Auth: cliente session via resolveClientFromSession.
// =============================================================================

export async function GET() {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'DATABASE_URL is not set' },
      { status: 503 },
    );
  }

  // We need the tier to drive the visibility predicate. Fetch it once,
  // then read the latest step rows for the cliente. Both are simple
  // primary-key reads; the volume is small (1 client + ~12 step rows
  // max in the happy path).
  const [client, savedRows] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true },
    }),
    readLatestStepsForClient(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE),
  ]);

  const tier = client?.tier ?? 'starter';
  const savedMap = buildSavedStateMap(
    savedRows.map((r) => ({
      stepKey: r.stepKey,
      latest: r.latest
        ? {
            status: r.latest.status,
            submittedAt: r.latest.submittedAt?.toISOString() ?? null,
            approvedAt: r.latest.approvedAt?.toISOString() ?? null,
            activeForBot: r.latest.activeForBot,
          }
        : null,
    })),
  );

  const response = listStepsForClient(tier as 'starter' | 'pro' | 'premium', savedMap);
  return NextResponse.json(response);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
