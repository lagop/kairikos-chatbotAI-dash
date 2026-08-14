import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { retryFailedRequests } from '@/lib/review-request-campaign';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-22b — POST /api/portal/google-business/campaigns/[id]/retry-failed
 * Re-sends ONLY the requests still in 'failed' status for this campaign
 * — retryFailedRequests never touches a 'sent' row, so this can be
 * clicked repeatedly without risking a duplicate invitation.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const campaign = await prisma.reviewRequestCampaign.findUnique({ where: { id: params.id } });
  if (!campaign || campaign.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { companyName: true, name: true },
  });
  const businessName = client?.companyName ?? client?.name ?? 'Nuestro negocio';

  const result = await retryFailedRequests(campaign.id, businessName);
  return NextResponse.json(result);
}
