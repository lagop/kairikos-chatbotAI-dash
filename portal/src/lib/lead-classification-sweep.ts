import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { classifyConversationForLead, type ClassifiedExample } from './lead-classification-ai';
import { ingestClassifiedLead, LEADS_CLASSIFICATION_MONTHLY_CAP } from './leads';
import { logError } from './observability';

// =============================================================================
// "Sistema IA de captación" — the classify-leads cron sweep. Same shape as
// conversation-digest.ts's generateDueDigests: one query for "what's due",
// then a per-item try/catch loop so one bad conversation never blocks the
// rest, called from GET /api/cron/classify-leads (wired into
// scripts/scheduler.sh's ENDPOINTS).
//
// "Due" = ChatbotConversation.outcome IS NOT NULL (the conversation is
// closed — classifying a still-open chat would score an incomplete
// signal) AND leadsClassifiedAt IS NULL (never run through the classifier)
// AND the client has 'leads' contracted. A conversation that never
// receives an outcome is never classified in v1 — known limitation,
// documented in the schema comment on leadsClassifiedAt, not fixed here.
// =============================================================================

const SWEEP_BATCH_SIZE = 200;

export interface ClassificationSweepResult {
  /** Conversations that matched the "due" query this tick. */
  swept: number;
  /** Conversations actually sent to the classifier (excludes capped/no-key skips). */
  classified: number;
  /** Leads created from a classifier isLead:true verdict. */
  leadsCreated: number;
  /** Conversations skipped because the client's monthly cap was already hit. */
  capped: number;
}

/** UTC calendar month, not per-client local time — a cost quota, not a
 *  client-facing report boundary. Same convention as prospecting.ts's own
 *  isNewCalendarMonth. */
function isNewCalendarMonth(usageResetAt: Date, now: Date): boolean {
  return usageResetAt.getUTCFullYear() !== now.getUTCFullYear() || usageResetAt.getUTCMonth() !== now.getUTCMonth();
}

/**
 * Resolve (and reset if a new calendar month has started) the client's
 * classification-cap state, lazily creating LeadQualificationProfile if
 * the client has never touched their qualification card — same "first
 * real need creates the row" posture as every other client profile in
 * this schema. Returns null only when the client's 'leads' ClientProduct
 * has vanished mid-sweep (raced away between the due-query and here) —
 * the caller skips that conversation quietly, the next sweep's due-query
 * won't select it again since it no longer matches the join.
 */
async function resolveCapState(
  prisma: PrismaClient,
  clientId: string,
  now: Date,
): Promise<{ classificationsThisMonth: number } | null> {
  const existing = await prisma.leadQualificationProfile.findUnique({
    where: { clientId },
    select: { classificationsThisMonth: true, usageResetAt: true },
  });

  if (existing) {
    if (isNewCalendarMonth(existing.usageResetAt, now)) {
      const reset = await prisma.leadQualificationProfile.update({
        where: { clientId },
        data: { classificationsThisMonth: 0, usageResetAt: now },
        select: { classificationsThisMonth: true },
      });
      return { classificationsThisMonth: reset.classificationsThisMonth };
    }
    return { classificationsThisMonth: existing.classificationsThisMonth };
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId, status: 'active', product: { code: 'leads' } },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct) return null;

  const created = await prisma.leadQualificationProfile.create({
    data: { clientId, clientProductId: clientProduct.id, tenantId: clientProduct.tenantId, usageResetAt: now },
    select: { classificationsThisMonth: true },
  });
  return { classificationsThisMonth: created.classificationsThisMonth };
}

/** Fase 2.3 — cuántos leads ya cerrados se le enseñan al clasificador.
 *  Suficientes para calibrar, pocos para que el prompt no se vaya de
 *  tamaño ni el histórico antiguo pese más que el reciente. */
const MAX_EXAMPLES_PER_SIDE = 5;

/**
 * Los últimos leads que este cliente marcó como convertidos y como
 * descartados. Es el bucle de aprendizaje: no reentrena nada, le enseña al
 * modelo qué acabó sirviendo de verdad en ESTE negocio.
 *
 * Solo cuentan los que tienen `summary` — sin él no hay nada que aprender,
 * y meterlos vacíos solo gastaría prompt.
 */
async function loadClassifiedExamples(
  prisma: PrismaClient,
  clientId: string,
): Promise<ClassifiedExample[]> {
  const [converted, discarded] = await Promise.all([
    prisma.lead.findMany({
      where: { clientId, status: 'convertido', summary: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: MAX_EXAMPLES_PER_SIDE,
      select: { summary: true },
    }),
    prisma.lead.findMany({
      where: { clientId, status: 'descartado', summary: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: MAX_EXAMPLES_PER_SIDE,
      select: { summary: true },
    }),
  ]);

  return [
    ...converted.map((l) => ({ summary: l.summary as string, converted: true })),
    ...discarded.map((l) => ({ summary: l.summary as string, converted: false })),
  ];
}

async function incrementClassificationCount(prisma: PrismaClient, clientId: string): Promise<void> {
  await prisma.leadQualificationProfile.update({
    where: { clientId },
    data: { classificationsThisMonth: { increment: 1 } },
  });
}

export async function sweepDueConversationsForClassification(
  prisma: PrismaClient,
): Promise<ClassificationSweepResult> {
  const conversations = await prisma.chatbotConversation.findMany({
    where: {
      outcome: { not: null },
      leadsClassifiedAt: null,
      client: { clientProducts: { some: { status: 'active', product: { code: 'leads' } } } },
    },
    select: { id: true, clientId: true, tenantId: true, outcome: true, transcript: true, channel: true },
    orderBy: { startedAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
  });

  const now = new Date();
  let classified = 0;
  let leadsCreated = 0;
  let capped = 0;

  for (const conversation of conversations) {
    try {
      const capState = await resolveCapState(prisma, conversation.clientId, now);
      if (!capState) continue;
      if (capState.classificationsThisMonth >= LEADS_CLASSIFICATION_MONTHLY_CAP) {
        // Deliberately does NOT stamp leadsClassifiedAt — this
        // conversation is picked up again by the next sweep once the
        // cap resets, delayed rather than lost (see the schema comment).
        capped += 1;
        continue;
      }

      const [client, qualification, examples] = await Promise.all([
        prisma.chatbotClient.findUnique({
          where: { id: conversation.clientId },
          select: { name: true, companyName: true },
        }),
        prisma.leadQualificationProfile.findUnique({
          where: { clientId: conversation.clientId },
          select: { perfilClienteIdeal: true, senalesDescarte: true },
        }),
        loadClassifiedExamples(prisma, conversation.clientId),
      ]);
      if (!client) continue;

      const result = await classifyConversationForLead({
        businessName: client.companyName ?? client.name,
        qualification: qualification ?? null,
        outcome: conversation.outcome,
        transcript: conversation.transcript,
        examples,
      });

      if ('skipped' in result) {
        // No ANTHROPIC_API_KEY configured — nothing to charge, nothing
        // to mark done. The next sweep retries once a key is set.
        continue;
      }

      // Counts against the cap regardless of ok/isLead — the Anthropic
      // call is what costs money, whether or not it found a lead.
      await incrementClassificationCount(prisma, conversation.clientId);
      classified += 1;

      if (!result.ok) {
        logError('lead_classification_sweep.classify_failed', new Error(result.error), {
          conversationId: conversation.id,
        });
        continue; // leave leadsClassifiedAt null, retry next sweep
      }

      if (result.isLead) {
        // Fase 1.5 — antes esto era siempre null porque la conversación no
        // guardaba su canal, y el cliente veía "sin canal" en sus leads.
        // NULL solo en conversaciones anteriores a ese campo.
        const channel = conversation.channel;
        await ingestClassifiedLead(prisma, {
          conversation: { id: conversation.id, clientId: conversation.clientId, tenantId: conversation.tenantId },
          contactName: result.contactName,
          contactPhone: result.contactPhone,
          contactEmail: result.contactEmail,
          summary: result.summary,
          score: result.score,
          scoreReason: result.scoreReason,
          channel,
          actorId: 'system:classifier',
        });
        leadsCreated += 1;
      }

      await prisma.chatbotConversation.update({
        where: { id: conversation.id },
        data: { leadsClassifiedAt: now },
      });
    } catch (err) {
      logError('lead_classification_sweep.conversation_failed', err, { conversationId: conversation.id });
    }
  }

  return { swept: conversations.length, classified, leadsCreated, capped };
}
