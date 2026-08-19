import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ status: z.enum(['active', 'paused']) });

/**
 * WP-22b — PATCH /api/portal/google-business/campaigns/[id]
 * Pause/resume a campaign. Pausing only stops FUTURE sends (there is no
 * background sender today — sending happens synchronously at creation
 * and on retry-failed — so in practice this flags the campaign as
 * inactive for a later worker/UI to respect, e.g. hiding its retry
 * action).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const campaign = await prisma.reviewRequestCampaign.findUnique({ where: { id: params.id } });
  if (!campaign || campaign.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const updated = await prisma.reviewRequestCampaign.update({
    where: { id: params.id },
    data: { status: body.data.status },
  });
  return NextResponse.json({ id: updated.id, status: updated.status });
}
