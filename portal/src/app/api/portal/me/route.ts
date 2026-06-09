import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession, readDevEmailHeader } from '@/lib/portal-session';
import { MOCK_CLIENT } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json(MOCK_CLIENT);
  }
  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: {
      id: true,
      email: true,
      name: true,
      companyName: true,
      tier: true,
      stripeCustomerId: true,
      goLiveAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({
    id: client.id,
    slug: client.email,
    companyName: client.companyName ?? client.name,
    primaryContactEmail: client.email,
    stripeCustomerId: client.stripeCustomerId,
    tier: client.tier,
    onboardingStatus: client.goLiveAt ? 'live' : 'in_progress',
    createdAt: client.createdAt.toISOString(),
    goLiveDate: client.goLiveAt?.toISOString() ?? null,
    chatbotSpaceId: null,
    contactName: client.name,
  });
}
