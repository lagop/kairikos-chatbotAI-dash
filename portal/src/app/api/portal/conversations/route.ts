import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { MOCK_CONVERSATIONS } from '@/lib/portal-data';

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
    return NextResponse.json({ conversations: MOCK_CONVERSATIONS.slice(0, 50) });
  }
  const rows = await prisma.chatbotConversation.findMany({
    where: { clientId: resolved.clientId },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      startedAt: true,
      duration: true,
      outcome: true,
    },
  });
  return NextResponse.json({
    conversations: rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      durationSeconds: r.duration ?? 0,
      outcome: r.outcome ?? 'unknown',
      channel: 'other',
    })),
  });
}
