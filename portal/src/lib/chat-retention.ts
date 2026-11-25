import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { conversationLastActivity } from './chatbot-export';
import { toClientDataAuditData, type ClientDataAuditInput } from './client-data-audit';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';
import { getOperatorAlertRecipients } from './operator-alert-settings';
import {
  claimDailyOperatorDigest,
  releaseDailyOperatorDigest,
  sendOperatorNotification,
  utcDayKey,
} from './operator-notify';
import { logError } from './observability';

// =============================================================================
// RGPD, encargo del tratamiento — PR 4 del plan (25/11/2026): el plazo de
// conservación de las conversaciones del chat.
//
// Aparte de retention-purge.ts a propósito: aquel borra lo que Kairikos trata
// como RESPONSABLE (herramientas gratuitas, prospección propia) con plazos de
// nuestra política de privacidad. Esto borra datos del CLIENTE, de los que
// Kairikos es encargado, con el plazo que fija el cliente: el campo
// «Retención» (`retencion_leads_dias`) del paso 10 del asistente. Lo llama la
// misma ruta de cron (/api/cron/retention-purge, cada cinco minutos).
//
// LAS REGLAS (decisión del propietario, 25/11/2026):
//   - El plazo cuenta desde la ÚLTIMA ACTIVIDAD de la conversación
//     (`conversationLastActivity`: la mayor entre startedAt + duration y las
//     fechas de la derivación a una persona), no desde que empezó.
//   - Vacío o 0: 12 meses de calendario.
//   - Menos de 30 días no se aplica (se usan los 12 meses) y se avisa al
//     operador por correo, una vez al día mientras siga así. Borrar a la
//     semana una conversación que el cliente aún no ha leído es más fácil de
//     configurar por error que a propósito.
//   - Con la conversación caen los resúmenes (ConversationDigest) cuya
//     ventana acabó antes del mismo corte: llevan frases sacadas de ellas.
//   - Las solicitudes (Lead) NO se borran: su conversation_id pasa a nulo
//     solo (ON DELETE SET NULL) y la solicitud sigue en la bandeja.
//
// EL MODO va en una constante del código, no en una variable de entorno:
// pasar de contar a borrar tiene que ser un PR que alguien revisa (el 4b del
// plan), no un valor que se cambia en un servidor sin dejar rastro. En
// 'dry_run' no borra nada: cuenta lo que borraría, lo devuelve en la
// respuesta del cron (el log del scheduler) y deja una fila
// `retention_dry_run` en ClientDataAudit por chatbot y día.
//
// Idempotente, como exige el scheduler: cada pasada busca solo lo vencido. Va
// por tandas de CHAT_RETENTION_BATCH conversaciones por grupo, de la más
// antigua a la más reciente; un atasco de años se reparte entre pasadas.
// =============================================================================

export type ChatRetentionMode = 'dry_run' | 'purge';

/** PR 4a: solo cuenta. El PR 4b cambia esta línea a 'purge'. */
export const CHAT_RETENTION_MODE: ChatRetentionMode = 'dry_run';

export const DEFAULT_CHAT_RETENTION_MONTHS = 12;
export const MIN_CHAT_RETENTION_DAYS = 30;
export const CHAT_RETENTION_BATCH = 1000;
export const CHAT_RETENTION_ACTOR = 'system:chat-retention' as const;
export const RETENTION_STEP_KEY = '10';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lo que dice el campo del paso 10, ya interpretado. */
export type ChatRetentionSetting =
  | { kind: 'default' }
  | { kind: 'days'; days: number }
  /** Por debajo del mínimo: se aplica el plazo por defecto y se avisa. */
  | { kind: 'too_short'; days: number };

export function parseChatRetention(raw: unknown): ChatRetentionSetting {
  if (raw === undefined || raw === null || raw === '') return { kind: 'default' };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return { kind: 'default' };
  const days = Math.floor(n);
  if (days < MIN_CHAT_RETENTION_DAYS) return { kind: 'too_short', days };
  return { kind: 'days', days };
}

/** El corte: lo que tuvo su última actividad antes de esta fecha, vence.
 *  El defecto son meses de calendario («12 meses» = el mismo día un año
 *  antes); los días del paso 10, días de 24 h. */
export function chatRetentionCutoff(now: Date, setting: ChatRetentionSetting): Date {
  if (setting.kind === 'days') return new Date(now.getTime() - setting.days * DAY_MS);
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DEFAULT_CHAT_RETENTION_MONTHS);
  return cutoff;
}

function retentionDaysOf(setting: ChatRetentionSetting): number | undefined {
  return setting.kind === 'days' ? setting.days : undefined;
}

/** Un conjunto de conversaciones con el mismo corte. */
interface RetentionGroup {
  /** Vale igual para ChatbotConversation y ConversationDigest: los dos
   *  tienen clientId y clientProductId con esos nombres. */
  where: { clientProductId?: string | null | { in: string[] }; clientId?: string | { in: string[] }; NOT?: unknown };
  cutoff: Date;
  retentionDays?: number;
}

interface ShortRetention {
  clientId: string;
  clientProductId: string | null;
  days: number;
}

/**
 * Los grupos a partir de los pasos 10 aprobados (activeForBot).
 *
 *   - Un chatbot con días propios: sus conversaciones (por clientProductId).
 *   - Las conversaciones sin chatbot (clientProductId nulo, filas de antes de
 *     la multi-instancia): las del cliente, con el plazo MÁS LARGO de sus
 *     chatbots. Ante la duda se conserva: un borrado no tiene vuelta atrás.
 *   - Todo lo demás: 12 meses.
 */
export async function loadChatRetentionGroups(
  prisma: PrismaClient,
  now: Date,
): Promise<{ groups: RetentionGroup[]; short: ShortRetention[] }> {
  const rows = await prisma.chatbotConfigStep.findMany({
    where: { productCode: CHATBOT_PRODUCT_CODE, stepKey: RETENTION_STEP_KEY, activeForBot: true },
    select: { clientId: true, clientProductId: true, payload: true },
  });

  const defaultCutoff = chatRetentionCutoff(now, { kind: 'default' });
  const short: ShortRetention[] = [];
  const productGroups: RetentionGroup[] = [];
  const productIds: string[] = [];
  /** Por cliente, el corte más antiguo (el plazo más largo) de sus chatbots. */
  const clientCutoff = new Map<string, { cutoff: Date; retentionDays?: number }>();

  for (const row of rows) {
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
    const setting = parseChatRetention(payload.retencion_leads_dias);
    if (setting.kind === 'too_short') short.push({ clientId: row.clientId, clientProductId: row.clientProductId, days: setting.days });
    const cutoff = chatRetentionCutoff(now, setting);
    const retentionDays = retentionDaysOf(setting);

    const current = clientCutoff.get(row.clientId);
    if (!current || cutoff < current.cutoff) clientCutoff.set(row.clientId, { cutoff, retentionDays });

    if (row.clientProductId && setting.kind === 'days') {
      productIds.push(row.clientProductId);
      productGroups.push({ where: { clientProductId: row.clientProductId }, cutoff, retentionDays });
    }
  }

  const clientGroups: RetentionGroup[] = [];
  const clientIds: string[] = [];
  for (const [clientId, { cutoff, retentionDays }] of clientCutoff) {
    if (cutoff.getTime() === defaultCutoff.getTime()) continue;
    clientIds.push(clientId);
    clientGroups.push({ where: { clientId, clientProductId: null }, cutoff, retentionDays });
  }

  const exclusions = [
    ...(productIds.length > 0 ? [{ clientProductId: { in: productIds } }] : []),
    ...(clientIds.length > 0 ? [{ clientId: { in: clientIds }, clientProductId: null }] : []),
  ];
  const defaultGroup: RetentionGroup = {
    where: exclusions.length > 0 ? { NOT: { OR: exclusions } } : {},
    cutoff: defaultCutoff,
  };

  return { groups: [...productGroups, ...clientGroups, defaultGroup], short };
}

/** Lo que no puede ser posterior al corte sin que la última actividad lo sea
 *  también. Deja para el filtro en memoria solo `duration`, que Prisma no
 *  sabe sumar a startedAt. */
function candidateWhere(group: RetentionGroup): Prisma.ChatbotConversationWhereInput {
  const beforeCutoff = (field: 'handoffRequestedAt' | 'handoffTakenAt' | 'handoffClosedAt') => ({
    OR: [{ [field]: null }, { [field]: { lt: group.cutoff } }],
  });
  return {
    AND: [
      group.where as Prisma.ChatbotConversationWhereInput,
      { startedAt: { lt: group.cutoff } },
      beforeCutoff('handoffRequestedAt'),
      beforeCutoff('handoffTakenAt'),
      beforeCutoff('handoffClosedAt'),
    ],
  };
}

function digestWhere(group: RetentionGroup): Prisma.ConversationDigestWhereInput {
  return { AND: [group.where as Prisma.ConversationDigestWhereInput, { windowEnd: { lt: group.cutoff } }] };
}

const keyOf = (clientId: string, clientProductId: string | null) => `${clientId}|${clientProductId ?? ''}`;

interface ChatbotTally {
  clientId: string;
  clientProductId: string | null;
  tenantId: string | null;
  conversations: number;
  digests: number;
  cutoff: Date;
  retentionDays?: number;
}

export interface ChatRetentionResult {
  mode: ChatRetentionMode;
  /** En 'dry_run', las que se borrarían; en 'purge', las borradas. */
  conversations: number;
  digests: number;
  /** Chatbots (cliente + contratación) con algo vencido. */
  chatbots: number;
  /** Algún grupo llenó su tanda: hay más vencidas de las que se cuentan. */
  truncated: boolean;
  /** Pasos 10 con menos de MIN_CHAT_RETENTION_DAYS días. */
  shortRetentionIgnored: number;
  operatorNotified: boolean;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function auditInput(tally: ChatbotTally, action: 'retention_dry_run' | 'retention_purged'): ClientDataAuditInput {
  return {
    clientId: tally.clientId,
    clientProductId: tally.clientProductId,
    tenantId: tally.tenantId,
    productCode: 'chatbot',
    action,
    actor: CHAT_RETENTION_ACTOR,
    metadata: {
      count: tally.conversations,
      digests: tally.digests,
      cutoff: tally.cutoff.toISOString(),
      retentionDays: tally.retentionDays,
    },
  };
}

async function processGroup(
  prisma: PrismaClient,
  group: RetentionGroup,
  mode: ChatRetentionMode,
  tallies: Map<string, ChatbotTally>,
): Promise<{ conversations: number; digests: number; truncated: boolean }> {
  const candidates = await prisma.chatbotConversation.findMany({
    where: candidateWhere(group),
    select: {
      id: true,
      clientId: true,
      clientProductId: true,
      tenantId: true,
      startedAt: true,
      duration: true,
      handoffRequestedAt: true,
      handoffTakenAt: true,
      handoffClosedAt: true,
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: CHAT_RETENTION_BATCH,
  });
  const expired = candidates.filter((c) => conversationLastActivity(c) < group.cutoff);

  const digestCounts = await prisma.conversationDigest.groupBy({
    by: ['clientId', 'clientProductId'],
    where: digestWhere(group),
    _count: { _all: true },
  });

  const local = new Map<string, ChatbotTally>();
  const tally = (clientId: string, clientProductId: string | null, tenantId: string | null) => {
    const key = keyOf(clientId, clientProductId);
    let t = local.get(key);
    if (!t) {
      t = { clientId, clientProductId, tenantId, conversations: 0, digests: 0, cutoff: group.cutoff, retentionDays: group.retentionDays };
      local.set(key, t);
    }
    if (!t.tenantId && tenantId) t.tenantId = tenantId;
    return t;
  };
  for (const c of expired) tally(c.clientId, c.clientProductId, c.tenantId).conversations += 1;
  for (const d of digestCounts) tally(d.clientId, d.clientProductId, null).digests += d._count._all;

  const digests = digestCounts.reduce((sum, d) => sum + d._count._all, 0);
  if (expired.length === 0 && digests === 0) return { conversations: 0, digests: 0, truncated: false };

  if (mode === 'purge') {
    // Todo o nada: la fila de auditoría va en la misma transacción que el
    // borrado, así que no hay borrado sin rastro ni rastro de un borrado que
    // no pasó.
    await prisma.$transaction([
      prisma.conversationDigest.deleteMany({ where: digestWhere(group) }),
      prisma.chatbotConversation.deleteMany({ where: { id: { in: expired.map((c) => c.id) } } }),
      prisma.clientDataAudit.createMany({
        data: [...local.values()].map((t) => toClientDataAuditData(auditInput(t, 'retention_purged'))),
      }),
    ]);
  }

  for (const [key, t] of local) tallies.set(key, t);
  return { conversations: expired.length, digests, truncated: candidates.length === CHAT_RETENTION_BATCH };
}

/** En 'dry_run', una fila por chatbot y día: el cron pasa cada cinco minutos
 *  y 288 filas iguales al día no dicen nada que no diga una. */
async function recordDryRun(prisma: PrismaClient, tallies: ChatbotTally[], now: Date): Promise<void> {
  if (tallies.length === 0) return;
  const today = await prisma.clientDataAudit.findMany({
    where: { productCode: 'chatbot', action: 'retention_dry_run', createdAt: { gte: startOfUtcDay(now) } },
    select: { clientId: true, clientProductId: true },
  });
  const done = new Set(today.map((r) => keyOf(r.clientId, r.clientProductId)));
  const pending = tallies.filter((t) => !done.has(keyOf(t.clientId, t.clientProductId)));
  if (pending.length === 0) return;
  await prisma.clientDataAudit.createMany({
    data: pending.map((t) => toClientDataAuditData(auditInput(t, 'retention_dry_run'))),
  });
}

/** Un correo al día al operador con los chatbots cuyo paso 10 pide menos del
 *  mínimo. Falla en silencio (log): el aviso no puede tumbar el borrado. */
async function notifyShortRetention(prisma: PrismaClient, short: ShortRetention[], now: Date): Promise<boolean> {
  if (short.length === 0) return false;
  logError(
    'chat_retention.short_ignored',
    new Error(`${short.length} paso(s) 10 con menos de ${MIN_CHAT_RETENTION_DAYS} días de retención`),
    { clientIds: short.map((s) => s.clientId).join(',') },
    'warn',
  );
  try {
    const subject = `Retención del chat por debajo de ${MIN_CHAT_RETENTION_DAYS} días (${short.length})`;
    const claim = await claimDailyOperatorDigest(prisma, { kind: 'chat-retention-short', day: utcDayKey(now), subject });
    if (!claim.claimed) return false;

    const clients = await prisma.chatbotClient.findMany({
      where: { id: { in: [...new Set(short.map((s) => s.clientId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    const lineas = [
      `Estos chatbots tienen en el paso 10 («Retención») menos de ${MIN_CHAT_RETENTION_DAYS} días.`,
      `No se aplica: sus conversaciones se guardan ${DEFAULT_CHAT_RETENTION_MONTHS} meses desde la última actividad.`,
      'Habla con el cliente y corrige el paso, o déjalo vacío.',
      '',
      ...short.map((s) => `- ${nameOf.get(s.clientId) ?? s.clientId}: ${s.days} días`),
    ];
    const sent = await sendOperatorNotification({
      kind: 'chat-retention-short',
      to: await getOperatorAlertRecipients(),
      subject,
      text: lineas.join('\n'),
      html: `<pre style="font-family:system-ui,sans-serif">${lineas
        .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
        .join('\n')}</pre>`,
    });
    if (!sent.ok) {
      logError('chat_retention.notify_failed', new Error(sent.error), {}, 'warn');
      await releaseDailyOperatorDigest(prisma, claim.id);
      return false;
    }
    return true;
  } catch (err) {
    logError('chat_retention.notify_failed', err, {}, 'warn');
    return false;
  }
}

/**
 * Una pasada. Lanza si falla la base de datos (la ruta de cron responde 500 y
 * sale como FAILED en el log del scheduler), salvo el correo al operador.
 */
export async function runChatRetention(
  prisma: PrismaClient,
  now: Date = new Date(),
  mode: ChatRetentionMode = CHAT_RETENTION_MODE,
): Promise<ChatRetentionResult> {
  const { groups, short } = await loadChatRetentionGroups(prisma, now);
  const tallies = new Map<string, ChatbotTally>();
  let conversations = 0;
  let digests = 0;
  let truncated = false;
  for (const group of groups) {
    const r = await processGroup(prisma, group, mode, tallies);
    conversations += r.conversations;
    digests += r.digests;
    truncated ||= r.truncated;
  }
  if (mode === 'dry_run') await recordDryRun(prisma, [...tallies.values()], now);
  const operatorNotified = await notifyShortRetention(prisma, short, now);
  return { mode, conversations, digests, chatbots: tallies.size, truncated, shortRetentionIgnored: short.length, operatorNotified };
}
