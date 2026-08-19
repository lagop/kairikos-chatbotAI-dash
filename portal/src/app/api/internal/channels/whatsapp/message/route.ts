import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/whatsapp/message
//
// Mirror of .../telegram/message, same inactivity-bounded session logic
// (see that route's comment for why) — a WhatsApp `wa_id` (the sender's
// phone number) is just as stable-forever as a Telegram chat id.
// =============================================================================

const INACTIVITY_MS = 6 * 60 * 60_000;

const BodySchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  from: z.string().trim().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
  outcome: z.enum(['resolved', 'escalated', 'abandoned', 'fallback', 'unknown']).optional(),
});

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'whatsapp', externalId: body.data.phoneNumberId },
  });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const now = new Date();
  const sessionPrefix = `whatsapp-${body.data.from}-`;
  const entry = { role: body.data.role, content: body.data.content, at: now.toISOString() };

  const latest = await prisma.chatbotConversation.findFirst({
    where: { clientId: connection.clientId, externalSessionId: { startsWith: sessionPrefix } },
    orderBy: { startedAt: 'desc' },
  });
  const lastActivityMs = latest ? latest.startedAt.getTime() + (latest.duration ?? 0) * 1000 : null;
  const isFresh = latest !== null && lastActivityMs !== null && now.getTime() - lastActivityMs <= INACTIVITY_MS;

  if (!isFresh) {
    const created = await prisma.chatbotConversation.create({
      data: {
        clientId: connection.clientId,
        tenantId: connection.tenantId,
        externalSessionId: `${sessionPrefix}${now.getTime()}`,
        startedAt: now,
        duration: 0,
        outcome: body.data.outcome ?? null,
        transcript: [entry],
      },
    });
    return NextResponse.json({ ok: true, conversationId: created.id });
  }

  const priorTranscript = Array.isArray(latest!.transcript) ? latest!.transcript : [];
  const updated = await prisma.chatbotConversation.update({
    where: { id: latest!.id },
    data: {
      duration: Math.max(0, Math.round((now.getTime() - latest!.startedAt.getTime()) / 1000)),
      outcome: body.data.outcome ?? latest!.outcome,
      transcript: [...priorTranscript, entry],
    },
  });
  return NextResponse.json({ ok: true, conversationId: updated.id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
