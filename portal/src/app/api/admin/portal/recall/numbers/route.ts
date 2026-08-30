import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { getTelephonyProvider, isTelephonyConfigured } from '@/lib/telephony';
import { provisionIntoPool, getPoolSummary } from '@/lib/recall-numbers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Provisioning is a loop of external purchases; the default 15s is not
// enough for a batch of ten.
export const maxDuration = 60;

const ProvisionSchema = z.object({
  countryCode: z.string().length(2).default('ES'),
  // Capped deliberately: this endpoint SPENDS MONEY on every call, one
  // recurring monthly charge per number. A typo of 100 where 10 was meant
  // should not be able to buy a hundred lines.
  count: z.number().int().min(1).max(20),
  areaCode: z.string().min(1).max(6).optional(),
});

/**
 * GET /api/admin/portal/recall/numbers
 *
 * The pool, for the operator panel. Assigned rows carry the client they
 * belong to so the operator can answer "which number is this client
 * forwarding to" without a second query.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const [numbers, summary] = await Promise.all([
    prisma.virtualNumber.findMany({
      orderBy: [{ status: 'asc' }, { provisionedAt: 'asc' }],
      select: {
        id: true,
        provider: true,
        e164: true,
        countryCode: true,
        status: true,
        provisionedAt: true,
        assignedAt: true,
        releasedAt: true,
        lastError: true,
        subscription: {
          select: {
            id: true,
            clientId: true,
            status: true,
            client: { select: { companyName: true, name: true } },
          },
        },
      },
    }),
    getPoolSummary(prisma),
  ]);

  return NextResponse.json({ numbers, summary });
}

/**
 * POST /api/admin/portal/recall/numbers
 *
 * Buy numbers into the pool. Best-effort per number — the response
 * reports what was bought and what failed rather than rolling the batch
 * back, because the usual failure (the candidate was taken between our
 * search and our purchase) is per-number and the rest of the batch is
 * perfectly good.
 *
 * 200 even on partial failure: the operator needs to see BOTH lists.
 * A 502 here would hide the numbers that did get bought, and those are
 * already being billed.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!(await isTelephonyConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'telephony_not_configured' }, { status: 503 });
  }

  const body = ProvisionSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const result = await provisionIntoPool(prisma, getTelephonyProvider(), {
    countryCode: body.data.countryCode,
    count: body.data.count,
    areaCode: body.data.areaCode,
    // Set at purchase time so a number is never live without a handler.
    // Fase 3 is what makes this URL answer anything useful.
    voiceWebhookUrl: process.env.TWILIO_VOICE_WEBHOOK_URL,
  });

  if ('error' in result) {
    return NextResponse.json({ error: 'provider_error', detail: result.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    provisioned: result.provisioned,
    failed: result.failed,
    summary: await getPoolSummary(prisma),
  });
}
