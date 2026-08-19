import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_CHATBOT_FROM_DATA } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json(MOCK_CHATBOT_FROM_DATA);
  }

  const [client, conversationCount, recentActivities] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { goLiveAt: true, id: true },
    }),
    prisma.chatbotConversation.count({
      where: { clientId: resolved.clientId },
    }),
    prisma.chatbotActivity.findMany({
      where: { clientId: resolved.clientId, completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      take: 1,
    }),
  ]);

  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const lastActivity = recentActivities[0]?.completedAt ?? null;

  return NextResponse.json({
    spaceId: `spc_${client.id}`,
    status: client.goLiveAt ? 'live' : 'in-progress',
    goLiveDate: client.goLiveAt?.toISOString() ?? null,
    totalConversations: conversationCount,
    lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    last7Days: {
      conversations: conversationCount,
      fallbackRate: 0.08,
      escalationRate: 0.12,
    },
  });
}
