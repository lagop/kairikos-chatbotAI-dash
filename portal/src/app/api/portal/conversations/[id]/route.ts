import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { MOCK_CONVERSATIONS } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    const summary = MOCK_CONVERSATIONS.find((c) => c.id === params.id);
    if (!summary) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({
      ...summary,
      endedAt: new Date(new Date(summary.startedAt).getTime() + summary.durationSeconds * 1000).toISOString(),
      messages: [
        { id: 'm1', role: 'user', content: 'Hola, ¿a qué hora abrís mañana?', at: summary.startedAt },
        { id: 'm2', role: 'assistant', content: '¡Hola! Abrimos de 9:30 a 14:00. ¿Quieres reservar?', at: new Date(new Date(summary.startedAt).getTime() + 4000).toISOString() },
      ],
    });
  }
  const row = await prisma.chatbotConversation.findFirst({
    where: { id: params.id, clientId: resolved.clientId },
    select: {
      id: true,
      startedAt: true,
      duration: true,
      outcome: true,
      transcript: true,
    },
  });
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const transcript = row.transcript as
    | { messages?: Array<{ id?: string; role?: string; content?: string; at?: string }>; channel?: string }
    | null;
  const endedAt = new Date(new Date(row.startedAt).getTime() + (row.duration ?? 0) * 1000).toISOString();
  return NextResponse.json({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt,
    durationSeconds: row.duration ?? 0,
    outcome: row.outcome ?? 'unknown',
    channel: transcript?.channel ?? 'other',
    messages: (transcript?.messages ?? []).map((m, i) => ({
      id: m.id ?? `m${i}`,
      role: (m.role ?? 'user') as 'user' | 'assistant' | 'system',
      content: m.content ?? '',
      at: m.at ?? row.startedAt.toISOString(),
    })),
  });
}
