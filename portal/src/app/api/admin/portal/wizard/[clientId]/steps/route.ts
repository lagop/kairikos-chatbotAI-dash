import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveInstanceForOperator } from '@/lib/client-product-access';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { listStepsForOperator, buildSavedStateMap } from '@/lib/wizard-visibility';
import {
  readLatestStepsForClient,
  resolveClientTier,
} from '@/lib/wizard-tier-prisma';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { PRODUCT_CODES, type ProductCode } from '@/lib/catalogs';

// =============================================================================
// KAIA-1166 (BE-4) — Operator-facing tier-agnostic wizard step list.
//
//   GET /api/admin/portal/wizard/[clientId]/steps?productCode=chatbot
//
// Always returns the full 12-step catalog for the chatbot product. The
// operator's view ignores the cliente's tier; Step 12 is rendered with
// `v11Deferred: true` so the frontend can show the "Próximamente" label
// without hiding the row.
//
// WP-18 — `productCode` is now an explicit, validated query param
// (defaulting to 'chatbot' for backward compatibility with the single
// existing caller). `listStepsForOperator`/`WIZARD_STEP_CATALOG` are
// chatbot-specific visibility machinery (tier gating, block grouping)
// that has no equivalent yet for the other four products — they still
// ship with empty catalogs (see `@/lib/catalogs`), so there is nothing
// to review there yet. Rather than force chatbot-shaped step numbers
// onto products that don't have any, this route short-circuits to an
// empty step list for every non-chatbot productCode.
//
// Auth: operator session cookie OR legacy `x-kaia-operator-key` header.
// =============================================================================

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

const CLIENT_ID_RE = /^[a-z0-9_-]{1,64}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: { clientId: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const { clientId } = params;
  if (!CLIENT_ID_RE.test(clientId)) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'clientId must match [a-z0-9_-]{1,64}' },
      { status: 400 },
    );
  }

  const productCodeRaw = req.nextUrl.searchParams.get('productCode') ?? CHATBOT_PRODUCT_CODE;
  if (!isProductCode(productCodeRaw)) {
    return NextResponse.json({ error: 'bad_request', detail: 'unknown productCode' }, { status: 400 });
  }
  const productCode = productCodeRaw;

  // Fase 4 multi-instancia — la lista de pasos de QUÉ chatbot. Ver
  // resolveInstanceForOperator: no exige contratación activa, y con varios
  // chatbots sin decir cuál pide elegir.
  const chatbot = await resolveInstanceForOperator(
    prisma,
    clientId,
    productCode,
    req.nextUrl.searchParams.get('clientProductId'),
  );
  if (!chatbot.ok) {
    return chatbot.reason === 'ambiguous'
      ? NextResponse.json({ error: 'chatbot_not_specified', detail: 'this client has several chatbots; pass clientProductId' }, { status: 409 })
      : NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const client = await resolveClientTier(prisma, clientId, chatbot.tier);
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (productCode !== CHATBOT_PRODUCT_CODE) {
    return NextResponse.json({ clientId, clientTier: client.tier, steps: [] });
  }

  const savedRows = await readLatestStepsForClient(prisma, clientId, productCode, chatbot.clientProductId);
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

  const response = listStepsForOperator(clientId, client.tier, savedMap);
  return NextResponse.json(response);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
