import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — POST /api/internal/channels/web/message
//
// Called by the n8n "Kairikos Webchat Multi-tenant" workflow once per
// turn (user message, then again for the bot's reply) to log the
// conversation into ChatbotConversation — the same table
// /portal/conversations and the Fase 7 digest already read. One row per
// widget session, upserted by (clientId, externalSessionId): appends to
// `transcript` and refreshes `duration` on every call, and only
// overwrites `outcome` when the caller actually sends one (n8n decides
// a conversation is resolved/escalated/fallback, not every turn).
//
// Not atomic (find-then-write, no SELECT ... FOR UPDATE) — acceptable
// here because a single browser tab's widget session sends turns
// sequentially, never concurrently, so there is no real race to guard
// against.
// =============================================================================

const BodySchema = z.object({
  publicToken: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(200),
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

  const embed = await prisma.chatWebEmbed.findUnique({ where: { publicToken: body.data.publicToken } });
  if (!embed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (embed.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const now = new Date();
  const entry = { role: body.data.role, content: body.data.content, at: now.toISOString() };

  const existing = await prisma.chatbotConversation.findUnique({
    where: { clientId_externalSessionId: { clientId: embed.clientId, externalSessionId: body.data.sessionId } },
  });

  if (!existing) {
    const created = await prisma.chatbotConversation.create({
      data: {
        clientId: embed.clientId,
        tenantId: embed.tenantId,
        externalSessionId: body.data.sessionId,
        startedAt: now,
        duration: 0,
        outcome: body.data.outcome ?? null,
        transcript: [entry],
      },
    });
    return NextResponse.json({ ok: true, conversationId: created.id });
  }

  const priorTranscript = Array.isArray(existing.transcript) ? existing.transcript : [];
  const updated = await prisma.chatbotConversation.update({
    where: { id: existing.id },
    data: {
      duration: Math.max(0, Math.round((now.getTime() - existing.startedAt.getTime()) / 1000)),
      outcome: body.data.outcome ?? existing.outcome,
      transcript: [...priorTranscript, entry],
    },
  });
  return NextResponse.json({ ok: true, conversationId: updated.id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
