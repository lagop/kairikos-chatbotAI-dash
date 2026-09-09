import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { ingestClassifiedLead } from '@/lib/leads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Leads Fase 3 — POST /api/internal/leads
//
// n8n calls this once a channel conversation's LLM classifier decides a
// turn contains a capturable lead. Same auth/shape convention as every
// other /api/internal/* route (see channels/telegram/message/route.ts).
//
// clientId/tenantId are resolved from `conversationId` against
// ChatbotConversation — never taken from the body — same reason the
// channel routes resolve via connectionId rather than trusting a
// caller-asserted clientId: it stops n8n from writing into an arbitrary
// tenant even if it can reach this endpoint.
//
// Dedup: if the classifier fires on more than one turn of the same
// conversation, a naive create-every-time would spam duplicate Lead rows
// for the same prospect. If a Lead already exists for this
// conversationId AND is still 'nuevo', refresh it in place instead of
// creating a new one. If the existing lead already moved past 'nuevo'
// (contactado/convertido/descartado), a fresh signal on the same
// conversation is treated as a new lead — reopening a closed one would
// silently undo a human decision.
// =============================================================================

const BodySchema = z.object({
  conversationId: z.string().trim().min(1),
  contactName: z.string().trim().min(1).max(200).optional(),
  contactPhone: z.string().trim().min(1).max(50).optional(),
  contactEmail: z.string().trim().email().max(200).optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
  score: z.number().int().min(0).max(100).optional(),
  // Leads Fase 9 — the classifier's own justification for `score`, shown
  // next to it everywhere the score is shown. Same length ceiling as
  // `summary`: both are LLM-extracted free text of the same rough shape.
  scoreReason: z.string().trim().min(1).max(2000).optional(),
  channel: z.enum(['telegram', 'whatsapp', 'messenger', 'instagram', 'web']).optional(),
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
  const data = body.data;

  const conversation = await prisma.chatbotConversation.findUnique({ where: { id: data.conversationId } });
  if (!conversation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Dedup, Lead/LeadAudit write, and the new-lead email all live in
  // ingestClassifiedLead (lib/leads.ts) — shared with the classify-leads
  // cron sweep so the two callers can never drift.
  const result = await ingestClassifiedLead(prisma, {
    conversation: { id: conversation.id, clientId: conversation.clientId, tenantId: conversation.tenantId },
    contactName: data.contactName ?? null,
    contactPhone: data.contactPhone ?? null,
    contactEmail: data.contactEmail ?? null,
    summary: data.summary ?? null,
    score: data.score ?? null,
    scoreReason: data.scoreReason ?? null,
    channel: data.channel ?? null,
    actorId: 'system:n8n',
  });

  return NextResponse.json({ ok: true, leadId: result.leadId });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
