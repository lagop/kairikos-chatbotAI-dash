import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { isProductContracted } from '@/lib/client-product-access';
import { sendNewLeadEmail } from '@/lib/leads-email';
import { logError } from '@/lib/observability';

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

  const existing = await prisma.lead.findFirst({
    where: { conversationId: data.conversationId, status: 'nuevo' },
  });

  if (existing) {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: existing.id },
        data: {
          contactName: data.contactName ?? existing.contactName,
          contactPhone: data.contactPhone ?? existing.contactPhone,
          contactEmail: data.contactEmail ?? existing.contactEmail,
          summary: data.summary ?? existing.summary,
          score: data.score ?? existing.score,
          channel: data.channel ?? existing.channel,
        },
      });
      await tx.leadAudit.create({
        data: {
          leadId: row.id,
          clientId: row.clientId,
          tenantId: row.tenantId,
          action: 'refreshed',
          statusBefore: 'nuevo',
          statusAfter: 'nuevo',
          actorId: 'system:n8n',
        },
      });
      return row;
    });
    return NextResponse.json({ ok: true, leadId: updated.id });
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.create({
      data: {
        clientId: conversation.clientId,
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        contactName: data.contactName ?? null,
        contactPhone: data.contactPhone ?? null,
        contactEmail: data.contactEmail ?? null,
        summary: data.summary ?? null,
        score: data.score ?? null,
        channel: data.channel ?? null,
      },
    });
    await tx.leadAudit.create({
      data: {
        leadId: row.id,
        clientId: row.clientId,
        tenantId: row.tenantId,
        action: 'created',
        statusBefore: null,
        statusAfter: 'nuevo',
        actorId: 'system:n8n',
      },
    });
    return row;
  });

  // Fase 6 — best-effort, never blocks the response the ingestion is
  // waiting on. Only fires HERE, on a genuinely new lead — the refresh
  // branch above must never re-notify on every later turn of the same
  // conversation. Gated on 'leads' specifically: a Lead can exist for a
  // client without that product (recall's phone-sourced leads reuse this
  // same model — see the schema comment on Lead.channel), and those
  // clients already get told about a missed call over WhatsApp by
  // recall's own messaging engine, so a second, unrelated "captación"
  // email would be redundant, not additive.
  try {
    const hasLeadsProduct = await isProductContracted(prisma, created.clientId, 'leads');
    if (hasLeadsProduct) {
      const client = await prisma.chatbotClient.findUnique({
        where: { id: created.clientId },
        select: { email: true, name: true, companyName: true },
      });
      if (client) {
        const emailResult = await sendNewLeadEmail({
          to: client.email,
          businessName: client.companyName ?? client.name,
          contactName: created.contactName,
          contactPhone: created.contactPhone,
          contactEmail: created.contactEmail,
          summary: created.summary,
          score: created.score,
          channel: created.channel,
        });
        if (!emailResult.ok) {
          logError('leads.new_lead_email_failed', new Error(emailResult.error), { leadId: created.id }, 'warn');
        }
      }
    }
  } catch (err) {
    logError('leads.new_lead_notification_failed', err, { leadId: created.id }, 'warn');
  }

  return NextResponse.json({ ok: true, leadId: created.id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
