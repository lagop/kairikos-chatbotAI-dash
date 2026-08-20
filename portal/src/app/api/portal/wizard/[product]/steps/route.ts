import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { listStepsForClient, buildSavedStateMap } from '@/lib/wizard-visibility';
import {
  readLatestStepsForClient,
} from '@/lib/wizard-tier-prisma';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { getProductCatalog, ProductCatalogError } from '@/lib/catalogs';
import { isProductContracted } from '@/lib/client-product-access';

// =============================================================================
// KAIA-1166 (BE-4) + WP-16 — Cliente-facing tier-filtered wizard step list,
// product-scoped.
//
//   GET /api/portal/wizard/[product]/steps
//
// See the sibling [step]/route.ts for the WP-16 rationale: only 'chatbot'
// has real step content today, so a real-but-empty product catalog
// returns a valid, empty step list rather than an error — there is
// nothing wrong with the request, the product just has no wizard yet.
//
// Auth: cliente session via resolveClientFromSession.
// =============================================================================

export async function GET(
  _req: Request,
  { params }: { params: { product: string } },
) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
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

  try {
    getProductCatalog(params.product);
  } catch (err) {
    if (err instanceof ProductCatalogError) {
      return NextResponse.json(
        { error: 'not_found', detail: `unknown product: ${params.product}` },
        { status: 404 },
      );
    }
    throw err;
  }

  const contracted = await isProductContracted(prisma, resolved.clientId, params.product);
  if (!contracted) {
    return NextResponse.json(
      { error: 'forbidden', detail: 'this product is not contracted for your account' },
      { status: 403 },
    );
  }

  if (params.product !== CHATBOT_PRODUCT_CODE) {
    // No catalog content yet — a valid empty list, not an error.
    return NextResponse.json({ clientTier: null, steps: [] });
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
