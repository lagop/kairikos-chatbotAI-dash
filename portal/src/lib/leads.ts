import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isProductContracted } from './client-product-access';
import { sendNewLeadEmail } from './leads-email';
import { deliverLeadToCrm } from './lead-webhook';
import { logError } from './observability';

// =============================================================================
// WP-XX — shared status-transition rules for Lead ("Captación con IA").
// Route handlers stay thin; this is where "is this transition allowed"
// lives so it can't drift between the internal ingestion route and the
// client-facing PATCH route. Mirrors src/lib/web-quotes.ts's shape.
//
// 'server-only' — client components must NOT import this file. They
// replicate the same string comparisons inline instead, same split
// WebQuoteEditor.tsx already uses for web-quotes.ts's predicates.
// =============================================================================

/**
 * Prospección con IA, Fase A — 'leads' and 'prospecting' feed the SAME
 * Lead inbox (a business found via Google Places is source:'outbound' on
 * the same model an inbound conversation lead uses), so either product
 * alone unlocks it. Without this, a client who bought only `prospecting`
 * would hit /portal/leads's "not contracted" pitch and have no way to
 * see the leads that already exist for them — a real gap caught during
 * planning, not a hypothetical one.
 */
export async function hasLeadsInboxAccess(prisma: PrismaClient, clientId: string): Promise<boolean> {
  const [hasLeads, hasProspecting] = await Promise.all([
    isProductContracted(prisma, clientId, 'leads'),
    isProductContracted(prisma, clientId, 'prospecting'),
  ]);
  return hasLeads || hasProspecting;
}

// ---------------------------------------------------------------------------
// Enriquecimiento — compartido por PATCH /api/internal/leads/[id]/enrich y
// el barrido de prospección (lib/prospecting-enrichment.ts), para que la
// escritura y su auditoría no diverjan entre los dos llamadores.
// ---------------------------------------------------------------------------

export interface LeadEnrichmentFields {
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactName?: string | null;
  scoreReason?: string | null;
}

/**
 * Completa los datos de contacto de un lead sin pisar lo que ya tenía.
 *
 * La semántica es deliberada: un campo vacío NUNCA borra uno existente
 * (`?? existente`). Quien enriquece aporta lo que ha encontrado; lo que no
 * ha encontrado no es información, es ausencia de ella.
 *
 * Devuelve null si el lead no existe, para que el que llama decida si eso
 * es un 404 o simplemente un lead borrado mientras tanto.
 */
export async function applyLeadEnrichment(
  prisma: PrismaClient,
  leadId: string,
  fields: LeadEnrichmentFields,
  actorId: string,
): Promise<{ leadId: string; changed: boolean } | null> {
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) return null;

  const next = {
    contactEmail: fields.contactEmail ?? existing.contactEmail,
    contactPhone: fields.contactPhone ?? existing.contactPhone,
    contactName: fields.contactName ?? existing.contactName,
    scoreReason: fields.scoreReason ?? existing.scoreReason,
  };

  const changed =
    next.contactEmail !== existing.contactEmail ||
    next.contactPhone !== existing.contactPhone ||
    next.contactName !== existing.contactName ||
    next.scoreReason !== existing.scoreReason;

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: existing.id }, data: next });
    await tx.leadAudit.create({
      data: {
        leadId: existing.id,
        clientId: existing.clientId,
        tenantId: existing.tenantId,
        action: 'enriched',
        statusBefore: existing.status,
        statusAfter: existing.status,
        actorId,
      },
    });
  });

  return { leadId: existing.id, changed };
}

// ---------------------------------------------------------------------------
// Ingestion — shared by POST /api/internal/leads and the classify-leads
// cron sweep (lib/lead-classification-sweep.ts), so lead creation, dedup,
// LeadAudit, and the new-lead email never drift between the two callers.
// ---------------------------------------------------------------------------

/** "Sistema IA de captación" — monthly cap on how many conversations the
 *  classify-leads cron sweep will run through the classifier per client.
 *  A single flat constant, not a per-tier map like prospecting's own
 *  TIER_LEAD_CAP — 'leads' only has one tier ('standard') today; revisit
 *  if a second tier is ever priced. */
export const LEADS_CLASSIFICATION_MONTHLY_CAP = 500;

export interface IngestClassifiedLeadConversation {
  id: string;
  clientId: string;
  tenantId: string | null;
}

export interface IngestClassifiedLeadInput {
  conversation: IngestClassifiedLeadConversation;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  summary: string | null;
  score: number | null;
  scoreReason: string | null;
  channel: string | null;
  /** 'system:n8n' for the legacy internal route, 'system:classifier' for
   *  the classify-leads cron sweep — surfaced on LeadAudit so the two
   *  sources stay distinguishable in the trail. */
  actorId: string;
}

export interface IngestClassifiedLeadResult {
  leadId: string;
  created: boolean;
}

/**
 * Create or refresh a Lead from a classified conversation turn, write its
 * LeadAudit row, and — only on genuine creation — send the new-lead email
 * to `emailAviso` (LeadQualificationProfile) if set, else the client's
 * account email. Same dedup rule POST /api/internal/leads always used: a
 * lead already 'nuevo' for this conversationId is refreshed in place; one
 * that already moved past 'nuevo' means a fresh signal creates a NEW lead
 * rather than reopening a closed one.
 */
export async function ingestClassifiedLead(
  prisma: PrismaClient,
  input: IngestClassifiedLeadInput,
): Promise<IngestClassifiedLeadResult> {
  const { conversation } = input;

  const existing = await prisma.lead.findFirst({
    where: { conversationId: conversation.id, status: 'nuevo' },
  });

  if (existing) {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: existing.id },
        data: {
          contactName: input.contactName ?? existing.contactName,
          contactPhone: input.contactPhone ?? existing.contactPhone,
          contactEmail: input.contactEmail ?? existing.contactEmail,
          summary: input.summary ?? existing.summary,
          score: input.score ?? existing.score,
          scoreReason: input.scoreReason ?? existing.scoreReason,
          channel: input.channel ?? existing.channel,
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
          actorId: input.actorId,
        },
      });
      return row;
    });
    return { leadId: updated.id, created: false };
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.create({
      data: {
        clientId: conversation.clientId,
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        contactEmail: input.contactEmail,
        summary: input.summary,
        score: input.score,
        scoreReason: input.scoreReason,
        channel: input.channel,
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
        actorId: input.actorId,
      },
    });
    return row;
  });

  // Best-effort, never blocks the caller. Gated on 'leads' specifically:
  // a Lead can exist for a client without that product (recall's
  // phone-sourced leads reuse this same model), and those clients
  // already get told about a missed call over WhatsApp by recall's own
  // messaging engine, so a second, unrelated "captación" email would be
  // redundant, not additive.
  try {
    const hasLeadsProduct = await isProductContracted(prisma, created.clientId, 'leads');
    if (hasLeadsProduct) {
      const [client, qualification] = await Promise.all([
        prisma.chatbotClient.findUnique({
          where: { id: created.clientId },
          select: { email: true, name: true, companyName: true },
        }),
        prisma.leadQualificationProfile.findUnique({
          where: { clientId: created.clientId },
          select: { emailAviso: true },
        }),
      ]);
      const to = qualification?.emailAviso || client?.email;
      if (client && to) {
        const emailResult = await sendNewLeadEmail({
          to,
          businessName: client.companyName ?? client.name,
          contactName: created.contactName,
          contactPhone: created.contactPhone,
          contactEmail: created.contactEmail,
          summary: created.summary,
          score: created.score,
          scoreReason: created.scoreReason,
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

  // Fase 4 — y al CRM del cliente, si lo tiene puesto. Aislado del correo
  // de arriba a propósito: son dos destinos independientes, y que su CRM
  // esté caído no puede impedir que le llegue el aviso por email.
  //
  // Aquí NO se comprueba el producto, al contrario que el correo: quien ve
  // un lead en su buzón puede llevárselo, y ese buzón es de 'leads' O de
  // 'prospecting' (hasLeadsInboxAccess). Configurar el webhook ya exige
  // ese acceso, así que tener uno guardado es la comprobación.
  // deliverLeadToCrm nunca lanza.
  await deliverLeadToCrm(prisma, {
    id: created.id,
    clientId: created.clientId,
    createdAt: created.createdAt,
    contactName: created.contactName,
    contactPhone: created.contactPhone,
    contactEmail: created.contactEmail,
    source: created.source,
    channel: created.channel,
    score: created.score,
    scoreReason: created.scoreReason,
    summary: created.summary,
  });

  return { leadId: created.id, created: true };
}

/** nuevo -> contactado */
export function canMarkContacted(status: string): boolean {
  return status === 'nuevo';
}

/** contactado -> convertido */
export function canMarkConverted(status: string): boolean {
  return status === 'contactado';
}

/** Side-exit, reachable from nuevo or contactado — mirrors WebQuote's 'cancelled'. */
export function canDiscard(status: string): boolean {
  return status === 'nuevo' || status === 'contactado';
}

// --- Client-facing list: sort/filter --------------------------------------
// Leads Fase 8 — the client's own /portal/leads was a flat, newest-first
// list with no way to sort by priority or filter down to one status.
// Fine while a client has a handful of leads; once volume grows, a
// high-score lead from last week is buried under a wall of low-score
// ones from this morning — exactly the "which ones matter" question the
// product's whole pitch is built on answering.

export const LEAD_STATUS_FILTERS = ['nuevo', 'contactado', 'convertido', 'descartado'] as const;
export type LeadStatusFilter = (typeof LEAD_STATUS_FILTERS)[number];

/** Validates a status filter from the query string. `null` means "todos"
 *  — the default, and the only fallback for anything unrecognised, so a
 *  malformed or hostile value never breaks the page, it just shows
 *  everything. Same clamp-don't-crash posture as recall-client-view.ts's
 *  clampMonth/clampPage. */
export function parseLeadStatusFilter(raw: string | string[] | undefined): LeadStatusFilter | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && (LEAD_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as LeadStatusFilter)
    : null;
}

export const LEAD_SORT_OPTIONS = ['recientes', 'prioridad'] as const;
export type LeadSortOption = (typeof LEAD_SORT_OPTIONS)[number];

/** 'recientes' (newest first) is the only sensible default for anything
 *  not recognised — same reasoning as the status filter above. */
export function parseLeadSort(raw: string | string[] | undefined): LeadSortOption {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'prioridad' ? 'prioridad' : 'recientes';
}

// --- Stuck detection -----------------------------------------------------
// Leads Fase 5 deliberately shipped this queue as read-only support
// visibility per-client only, on the reasoning that "the client's own
// sales team owns the whole status lifecycle" (see LeadsSummaryPanel.tsx).
// True, but it left a gap that recall.ts and web-quotes.ts both close for
// their own products: nothing told an OPERATOR when a client's team had
// simply stopped working their leads. From the system's point of view a
// lead sitting in 'nuevo' for three weeks is indistinguishable from one
// contacted a minute ago — it looks fine because nothing is technically
// broken. Same shape as recall.ts's stuck detection, on purpose.
const STUCK_AFTER_DAYS: Readonly<Partial<Record<string, number>>> = {
  // Waiting on the client's team to make first contact. Tighter than any
  // of recall's client-blocked thresholds — a lead goes cold in days, not
  // weeks, and the whole product's pitch is "we prioritise so you don't
  // waste the good ones by acting too late".
  nuevo: 2,
  // Waiting on the client's team to close it out (convertido or
  // descartado). More rope than 'nuevo' — a real sales cycle takes time —
  // but still finite. A lead 'contactado' for a month with no resolution
  // is a stalled deal nobody is tracking, not a healthy one.
  contactado: 14,
};

/** Days after which a lead sitting in `status` should be surfaced to an
 *  operator. Null for the terminal statuses (`convertido`, `descartado`)
 *  — those are resting states, not stuck ones. */
export function stuckThresholdDays(status: string): number | null {
  return STUCK_AFTER_DAYS[status] ?? null;
}

/** Whether a lead that entered `status` at `since` is overdue as of `now`.
 *  Pure — same reasoning as recall.ts's isStuck: the queue computes this
 *  at render time so there is no date arithmetic in the query and the
 *  thresholds stay in one testable place. */
export function isStuck(status: string, since: Date, now: Date = new Date()): boolean {
  const threshold = stuckThresholdDays(status);
  if (threshold === null) return false;
  const elapsedDays = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays >= threshold;
}

// --- Operator queue ------------------------------------------------------

export interface LeadQueueRow {
  leadId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  status: string;
  /** When this lead entered its CURRENT status — the clock the stuck
   *  badge reads. `createdAt` while `nuevo` (that IS when it entered);
   *  `contactedAt` once `contactado` (its own transition timestamp, not
   *  `updatedAt`, which any unrelated edit would reset and hide a lead
   *  that has actually been stalled for weeks). */
  since: Date;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  score: number | null;
  channel: string | null;
}

function enteredCurrentStateAt(row: { status: string; createdAt: Date; contactedAt: Date | null }): Date {
  if (row.status === 'contactado' && row.contactedAt) return row.contactedAt;
  return row.createdAt;
}

/**
 * Every lead still open (`nuevo` or `contactado`) across every client, for
 * the operator's inbox. ONE query — same shape as listRecallQueue and
 * listWebQuoteQueue, not a query-per-client loop.
 *
 * Deliberately still doesn't let the operator MUTATE a lead's status from
 * here — that stays the client's sales team's call, per the design this
 * queue is layered on top of (LeadsSummaryPanel.tsx). This is triage
 * visibility only: which clients have gone quiet on their own leads.
 */
export async function listLeadsQueue(prisma: PrismaClient): Promise<LeadQueueRow[]> {
  const rows = await prisma.lead.findMany({
    where: { status: { in: ['nuevo', 'contactado'] } },
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      clientId: true,
      status: true,
      createdAt: true,
      contactedAt: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      score: true,
      channel: true,
      client: { select: { name: true, companyName: true, email: true } },
    },
  });

  return rows.map((row) => ({
    leadId: row.id,
    clientId: row.clientId,
    clientName: row.client.companyName ?? row.client.name,
    clientEmail: row.client.email,
    status: row.status,
    since: enteredCurrentStateAt(row),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    score: row.score,
    channel: row.channel,
  }));
}
