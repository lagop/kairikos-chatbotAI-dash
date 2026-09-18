import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendTemplate } from './whatsapp-api';
import { decryptMetaToken } from './meta-business';
import { recordSend, metaMessageId } from './message-ledger';
import { RECOVERY_TEMPLATES, buildRecoveryParams } from './recovery-templates';
import {
  findRecoveryCandidates,
  exclusionFor,
  type RecoveryTrigger,
  type ExclusionReason,
} from './recovery-triggers';
import { logError } from './observability';

// =============================================================================
// Fase 3 — construir, aprobar y enviar una campaña de recuperación.
//
// TRES PASOS SEPARADOS, Y LA SEPARACIÓN ES EL PRODUCTO:
//
//   draftCampaign()        evalúa los disparadores y CONGELA la lista.
//   (una persona la mira y la aprueba, desde fuera de este módulo)
//   sendApprovedCampaign() envía, y solo si está aprobada.
//
// POR QUÉ LA APROBACIÓN HUMANA NO ES OPCIONAL EN ESTA FASE
//
// El primer envío masivo de un cliente sale de datos que nadie ha visto
// nunca: importes dictados a una nota de voz, nombres que entendió un
// modelo, fechas calculadas a partir de "hay que volver en un año". Un
// error en esos datos no es un error de software, es un mensaje raro a
// doscientos clientes reales del profesional que nos paga. Una persona
// mirando la lista antes cuesta cinco minutos y ahorra esa llamada.
//
// LAS DOS COMPROBACIONES, Y POR QUÉ NO SON REDUNDANTES
//
// La lista se congela al crear la campaña y las exclusiones se vuelven a
// evaluar al enviar. Hacen cosas distintas:
//
//   congelar    hace que lo aprobado sea exactamente lo que se manda. Si
//               la lista se recalculara en el envío, la aprobación no
//               valdría nada: se habría aprobado una lista y salido otra.
//
//   re-evaluar  atrapa a quien pidió la baja ENTRE la aprobación y el
//               envío. Puede pasar perfectamente: la campaña se aprueba
//               un lunes y se manda el martes, y el lunes por la tarde esa
//               persona contestó BAJA a otro mensaje.
//
// Nadie entra en la lista por la puerta de atrás, y nadie se queda dentro
// si se ha ido.
// =============================================================================

export interface DraftResult {
  campaignId: string;
  trigger: RecoveryTrigger;
  memberCount: number;
  /** Los que el disparador encontró pero no entraron, con su motivo. */
  excludedCount: number;
}

export interface CampaignSendResult {
  sent: number;
  failed: number;
  /** Excluidos EN EL ENVÍO, es decir, los que se fueron entre medias. */
  excludedLate: number;
  skipped?: 'not_approved' | 'no_sender' | 'no_members';
}

/**
 * Crea una campaña en borrador a partir de un disparador.
 *
 * Nace en 'draft' siempre. No hay parámetro para crearla ya aprobada, por
 * el mismo motivo por el que findRecoveryCandidates no tiene
 * `skipExclusions`: una comodidad hoy es un envío sin revisar dentro de
 * seis meses.
 */
export async function draftCampaign(
  prisma: PrismaClient,
  opts: { clientId: string; tenantId?: string | null; subscriptionId: string; trigger: RecoveryTrigger; now?: Date },
): Promise<DraftResult | null> {
  const now = opts.now ?? new Date();

  const run = await findRecoveryCandidates(prisma, {
    clientId: opts.clientId,
    subscriptionId: opts.subscriptionId,
    triggers: [opts.trigger],
    now,
  });

  // Una campaña sin destinatarios no se crea. Un borrador vacío esperando
  // aprobación es ruido en el panel de quien tiene que aprobar, y lo que
  // gasta la atención de un revisor es lo que hace que deje de revisar.
  if (run.candidates.length === 0) return null;

  const campaign = await prisma.recoveryCampaign.create({
    data: {
      clientId: opts.clientId,
      tenantId: opts.tenantId ?? null,
      subscriptionId: opts.subscriptionId,
      trigger: opts.trigger,
      status: 'draft',
      members: {
        create: run.candidates.map((c) => ({
          contactId: c.contactId,
          e164: c.e164,
          reason: c.reason,
          state: 'pending',
          ...(c.jobId ? { jobId: c.jobId } : {}),
          ...(c.serviceQuoteId ? { serviceQuoteId: c.serviceQuoteId } : {}),
        })),
      },
    },
    select: { id: true },
  });

  return {
    campaignId: campaign.id,
    trigger: opts.trigger,
    memberCount: run.candidates.length,
    excludedCount: run.excluded.length,
  };
}

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_draft' };

/**
 * Aprueba una campaña. Solo desde 'draft', y compare-and-swap.
 *
 * El `status: 'draft'` en el WHERE y no solo en una comprobación previa:
 * dos operadores pulsando aprobar a la vez no pueden dejar dos sellos
 * distintos sobre la misma campaña, que luego no se sabría cuál es.
 */
export async function approveCampaign(
  prisma: PrismaClient,
  campaignId: string,
  operatorId: string,
  now = new Date(),
): Promise<ApproveResult> {
  const updated = await prisma.recoveryCampaign.updateMany({
    where: { id: campaignId, status: 'draft' },
    data: { status: 'approved', approvedByOperatorId: operatorId, approvedAt: now },
  });
  if (updated.count > 0) return { ok: true };

  const exists = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true },
  });
  return { ok: false, reason: exists ? 'not_draft' : 'not_found' };
}

interface SenderCredentials {
  token: string;
  phoneNumberId: string;
  businessName: string;
}

async function resolveSender(
  prisma: PrismaClient,
  clientId: string,
): Promise<SenderCredentials | null> {
  const connection = await prisma.metaChannelConnection.findFirst({
    where: { clientId, channel: 'whatsapp', status: 'active' },
    select: {
      externalId: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
      client: { select: { name: true, companyName: true } },
    },
  });
  if (!connection) return null;

  try {
    return {
      token: decryptMetaToken({
        ciphertext: connection.accessTokenCiphertext,
        iv: connection.accessTokenIv,
        tag: connection.accessTokenTag,
      }),
      phoneNumberId: connection.externalId,
      businessName: connection.client.companyName ?? connection.client.name,
    };
  } catch (err) {
    logError('recovery_campaigns.sender_decrypt_failed', err, { clientId }, 'warn');
    return null;
  }
}

/**
 * Envía una campaña aprobada.
 *
 * SE NIEGA A TOCAR NADA QUE NO ESTÉ EN 'approved'. Es la comprobación por
 * la que existe la mitad de este módulo, así que va la primera y no
 * depende de que el llamante haya mirado antes.
 */
export async function sendApprovedCampaign(
  prisma: PrismaClient,
  campaignId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<CampaignSendResult> {
  const now = opts.now ?? new Date();
  const empty: CampaignSendResult = { sent: 0, failed: 0, excludedLate: 0 };

  const campaign = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, clientId: true, tenantId: true, subscriptionId: true, trigger: true, status: true },
  });
  if (!campaign || campaign.status !== 'approved') {
    return { ...empty, skipped: 'not_approved' };
  }

  const members = await prisma.recoveryCampaignMember.findMany({
    where: { campaignId, state: 'pending' },
    take: opts.limit ?? 200,
    select: {
      id: true,
      contactId: true,
      e164: true,
      contact: {
        select: { name: true, legalBasis: true, legalBasisCapturedAt: true },
      },
    },
  });
  if (members.length === 0) {
    await prisma.recoveryCampaign.update({
      where: { id: campaignId },
      data: { status: 'completed', completedAt: now },
    });
    return { ...empty, skipped: 'no_members' };
  }

  const sender = await resolveSender(prisma, campaign.clientId);
  if (!sender) return { ...empty, skipped: 'no_sender' };

  const template = RECOVERY_TEMPLATES[campaign.trigger as RecoveryTrigger];
  if (!template) return { ...empty, skipped: 'not_approved' };

  // La re-evaluación. Ver la cabecera: esto no duplica el filtro del
  // borrador, atrapa a quien se fue entre la aprobación y ahora.
  const numbers = members.map((m) => m.e164);
  const [suppressed, recent] = await Promise.all([
    prisma.recallBlockedNumber.findMany({
      where: { subscriptionId: campaign.subscriptionId, e164: { in: numbers } },
      select: { e164: true },
    }),
    prisma.outboundMessage.findMany({
      where: { clientId: campaign.clientId, toE164: { in: numbers }, ok: true },
      select: { toE164: true, sentAt: true },
      orderBy: { sentAt: 'desc' },
    }),
  ]);
  const suppressedSet = new Set(suppressed.map((s) => s.e164));
  const lastContact = new Map<string, Date>();
  for (const row of recent) if (!lastContact.has(row.toE164)) lastContact.set(row.toE164, row.sentAt);

  const result: CampaignSendResult = { sent: 0, failed: 0, excludedLate: 0 };

  for (const member of members) {
    const lateExclusion: ExclusionReason | null = exclusionFor({
      legalBasis: member.contact.legalBasis,
      legalBasisCapturedAt: member.contact.legalBasisCapturedAt,
      isSuppressed: suppressedSet.has(member.e164),
      lastContactedAt: lastContact.get(member.e164) ?? null,
      // No se vuelve a mirar la devolución agendada: es la única exclusión
      // que puede APARECER por culpa de esta misma campaña si el envío se
      // parte en tandas, y excluir a alguien por haber contestado a la
      // tanda anterior sería castigarle por hacernos caso.
      hasScheduledCallback: false,
      now,
    });

    if (lateExclusion) {
      await prisma.recoveryCampaignMember.update({
        where: { id: member.id },
        data: { state: 'excluded', excludedReason: lateExclusion },
      });
      result.excludedLate += 1;
      continue;
    }

    const sent = await sendTemplate(sender.token, sender.phoneNumberId, member.e164, {
      name: template.name,
      languageCode: template.languageCode,
      bodyParams: buildRecoveryParams(campaign.trigger as RecoveryTrigger, {
        contactName: member.contact.name,
        businessName: sender.businessName,
      }),
    });

    await recordSend(prisma, {
      clientId: campaign.clientId,
      subscriptionId: campaign.subscriptionId,
      tenantId: campaign.tenantId,
      productCode: 'recall',
      channel: 'whatsapp',
      kind: 'template',
      category: template.category,
      templateName: template.name,
      toE164: member.e164,
      providerMessageId: sent.ok ? metaMessageId(sent.data) : null,
      ok: sent.ok,
      error: sent.ok ? null : sent.error,
      sentAt: now,
    });

    await prisma.recoveryCampaignMember.update({
      where: { id: member.id },
      data: sent.ok
        ? { state: 'sent', sentAt: now, error: null }
        : { state: 'failed', error: sent.error.slice(0, 500) },
    });

    if (sent.ok) result.sent += 1;
    else result.failed += 1;

    // Perseguido una vez, no dos: el presupuesto queda marcado en cuanto
    // sale su mensaje, que es lo que lo saca del disparador la próxima vez.
    if (sent.ok && campaign.trigger === 'open_quote') {
      await prisma.serviceQuote
        .updateMany({
          where: { clientId: campaign.clientId, contactId: member.contactId, status: 'open' },
          data: { lastFollowedUpAt: now },
        })
        .catch((err) =>
          logError('recovery_campaigns.quote_stamp_failed', err, { campaignId }, 'warn'),
        );
    }
  }

  const remaining = await prisma.recoveryCampaignMember.count({
    where: { campaignId, state: 'pending' },
  });
  if (remaining === 0) {
    await prisma.recoveryCampaign.update({
      where: { id: campaignId },
      data: { status: 'completed', completedAt: now },
    });
  }

  return result;
}

// ===========================================================================
// Pantalla de operador — cancelar y listar
// ===========================================================================

export type CancelResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_cancellable' };

/**
 * Cancela una campaña que todavía no ha terminado.
 *
 * Desde 'draft' o 'approved', nunca desde 'completed': una campaña ya
 * enviada no se "cancela", ya ocurrió, y marcarla como cancelada
 * falsearía el histórico de lo que se le mandó a quién.
 *
 * Una aprobada a medio enviar sí se puede parar: el cron solo recoge
 * 'approved', así que en cuanto pasa a 'cancelled' los miembros que
 * seguían en 'pending' ya no salen. Los que ya salieron quedan como
 * 'sent', que es la verdad.
 *
 * Compare-and-swap como approveCampaign, por la misma carrera: cancelar
 * y aprobar a la vez no pueden dejar la campaña en un estado que nadie
 * pidió.
 */
export async function cancelCampaign(prisma: PrismaClient, campaignId: string): Promise<CancelResult> {
  const updated = await prisma.recoveryCampaign.updateMany({
    where: { id: campaignId, status: { in: ['draft', 'approved'] } },
    data: { status: 'cancelled' },
  });
  if (updated.count > 0) return { ok: true };

  const exists = await prisma.recoveryCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
  return { ok: false, reason: exists ? 'not_cancellable' : 'not_found' };
}

export interface CampaignSummary {
  id: string;
  trigger: string;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  completedAt: Date | null;
  counts: { pending: number; sent: number; failed: number; excluded: number };
  members: Array<{
    id: string;
    e164: string;
    name: string | null;
    reason: string;
    state: string;
    excludedReason: string | null;
    error: string | null;
  }>;
}

/** Las campañas de una suscripción, con sus destinatarios, para la pantalla
 *  de operador. Las más recientes primero. */
export async function listCampaignsForSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
  opts: { limit?: number; membersPerCampaign?: number } = {},
): Promise<CampaignSummary[]> {
  const campaigns = await prisma.recoveryCampaign.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 20,
    select: {
      id: true,
      trigger: true,
      status: true,
      createdAt: true,
      approvedAt: true,
      completedAt: true,
      approvedBy: { select: { email: true } },
      members: {
        orderBy: { createdAt: 'asc' },
        // Tope de pintado, no de campaña: una campaña de 500 destinatarios
        // se lista entera en los contadores, pero no se pintan 500 filas.
        take: opts.membersPerCampaign ?? 200,
        select: {
          id: true,
          e164: true,
          reason: true,
          state: true,
          excludedReason: true,
          error: true,
          contact: { select: { name: true } },
        },
      },
    },
  });

  const grouped = await prisma.recoveryCampaignMember.groupBy({
    by: ['campaignId', 'state'],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });

  return campaigns.map((c) => {
    const counts = { pending: 0, sent: 0, failed: 0, excluded: 0 };
    for (const g of grouped) {
      if (g.campaignId === c.id && g.state in counts) {
        counts[g.state as keyof typeof counts] = g._count._all;
      }
    }
    return {
      id: c.id,
      trigger: c.trigger,
      status: c.status,
      createdAt: c.createdAt,
      approvedAt: c.approvedAt,
      approvedByEmail: c.approvedBy?.email ?? null,
      completedAt: c.completedAt,
      counts,
      members: c.members.map((m) => ({
        id: m.id,
        e164: m.e164,
        name: m.contact?.name ?? null,
        reason: m.reason,
        state: m.state,
        excludedReason: m.excludedReason,
        error: m.error,
      })),
    };
  });
}
