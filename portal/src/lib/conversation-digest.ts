import 'server-only';
import type { ConversationDigestSchedule } from '@prisma/client';
import { prisma } from './prisma';
import { generateConversationDigest } from './conversation-summary-ai';
import { sendConversationDigestEmail } from './conversation-digest-email';
import { logError } from './observability';

// =============================================================================
// Canales Fase 7 — resúmenes periódicos de conversaciones. Mismo patrón
// que google-review-sync.ts: una función "sweep" (generateDueDigests)
// llamada por el cron, que delega en una función por-cliente
// (generateDigestForSchedule) que nunca lanza — cualquier fallo se
// aísla, un cliente con problemas nunca aborta el resto del sweep.
//
// A diferencia de isSyncDue() en google-review-sync.ts (un simple
// min-interval), acá "due" depende del preset del cliente:
//   - custom_interval: due cuando pasaron >= intervalHours desde el
//     último resumen (o nunca se generó uno).
//   - morning_noon_evening: due cuando el límite de franja (9/13/18h,
//     hora local del timezone del cliente) más reciente ya pasado quedó
//     después del último resumen generado.
// =============================================================================

const PRESET_SLOT_HOURS: Record<string, number[]> = {
  morning_noon_evening: [9, 13, 18],
};

const DEFAULT_CUSTOM_INTERVAL_HOURS = 4;
const FALLBACK_WINDOW_HOURS = 24;

function getZonedHourMinute(date: Date, timeZone: string): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

/**
 * The most recent wall-clock slot boundary (one of `hours`, in
 * `timezone`) at or before `now`. Computed as a relative offset from
 * `now` (not by reconstructing an absolute local date), so it stays
 * correct across offsets without needing full IANA date arithmetic —
 * good enough for a few-times-a-day nice-to-have feature, not meant to
 * be DST-exact to the minute.
 */
export function mostRecentSlotBoundary(now: Date, hours: number[], timezone: string): Date {
  const sorted = [...hours].sort((a, b) => a - b);
  const { hour, minute } = getZonedHourMinute(now, timezone);
  const nowMinutesOfDay = hour * 60 + minute;
  let bestSlotMinutes: number | null = null;
  for (const h of sorted) {
    const slotMinutes = h * 60;
    if (slotMinutes <= nowMinutesOfDay) bestSlotMinutes = slotMinutes;
  }
  if (bestSlotMinutes === null) {
    bestSlotMinutes = sorted[sorted.length - 1] * 60 - 24 * 60;
  }
  const diffMinutes = nowMinutesOfDay - bestSlotMinutes;
  return new Date(now.getTime() - diffMinutes * 60_000);
}

export function isDigestDue(schedule: ConversationDigestSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (schedule.preset === 'custom_interval') {
    const hours = schedule.intervalHours ?? DEFAULT_CUSTOM_INTERVAL_HOURS;
    if (!schedule.lastGeneratedAt) return true;
    return now.getTime() - schedule.lastGeneratedAt.getTime() >= hours * 60 * 60_000;
  }
  const slotHours = PRESET_SLOT_HOURS[schedule.preset] ?? PRESET_SLOT_HOURS.morning_noon_evening;
  const boundary = mostRecentSlotBoundary(now, slotHours, schedule.timezone);
  if (!schedule.lastGeneratedAt) return true;
  return schedule.lastGeneratedAt.getTime() < boundary.getTime();
}

export interface GenerateDigestOutcome {
  generated: boolean;
  reason?: 'not_due' | 'no_conversations';
}

/**
 * Generates (or skips) a digest for one client's schedule. Never
 * throws — errors from the AI call or the email send are isolated
 * (AI failure still persists a digest with a fallback summaryText;
 * email failure never blocks the digest from being saved, mirroring
 * web-quote-email.ts's "the record already exists before we try to
 * notify" principle).
 */
export async function generateDigestForSchedule(
  schedule: ConversationDigestSchedule,
  now: Date = new Date(),
): Promise<GenerateDigestOutcome> {
  if (!isDigestDue(schedule, now)) {
    return { generated: false, reason: 'not_due' };
  }

  const windowStart = schedule.lastGeneratedAt ?? new Date(now.getTime() - FALLBACK_WINDOW_HOURS * 60 * 60_000);
  const windowEnd = now;

  const conversations = await prisma.chatbotConversation.findMany({
    where: { clientId: schedule.clientId, startedAt: { gte: windowStart, lt: windowEnd } },
    orderBy: { startedAt: 'asc' },
    select: { startedAt: true, outcome: true, duration: true, transcript: true },
  });

  if (conversations.length === 0) {
    await prisma.conversationDigestSchedule.update({
      where: { id: schedule.id },
      data: { lastGeneratedAt: now },
    });
    return { generated: false, reason: 'no_conversations' };
  }

  const totalConversations = conversations.length;
  const escalatedCount = conversations.filter((c) => c.outcome === 'escalated').length;
  const fallbackCount = conversations.filter((c) => c.outcome === 'fallback').length;

  const client = await prisma.chatbotClient.findUnique({
    where: { id: schedule.clientId },
    select: { companyName: true, name: true, email: true },
  });
  const businessName = client?.companyName ?? client?.name ?? 'tu negocio';

  let summaryText = 'No se pudo generar un resumen automático de esta ventana (la IA no está configurada o falló). Los datos agregados sí están disponibles.';
  let highlights: string[] = [];

  const aiResult = await generateConversationDigest({
    businessName,
    conversations: conversations.map((c) => ({
      startedAt: c.startedAt,
      outcome: c.outcome,
      duration: c.duration,
      transcript: c.transcript,
    })),
  });
  if (aiResult.ok && !('skipped' in aiResult)) {
    summaryText = aiResult.summaryText;
    highlights = aiResult.highlights;
  } else if (!aiResult.ok) {
    logError('conversation_digest.ai_failed', new Error(aiResult.error), {
      route: 'lib/conversation-digest.ts',
      clientId: schedule.clientId,
    }, 'warn');
  }

  await prisma.conversationDigest.create({
    data: {
      clientId: schedule.clientId,
      tenantId: schedule.tenantId,
      windowStart,
      windowEnd,
      totalConversations,
      escalatedCount,
      fallbackCount,
      summaryText,
      highlights,
    },
  });

  await prisma.conversationDigestSchedule.update({
    where: { id: schedule.id },
    data: { lastGeneratedAt: now },
  });

  if (client?.email) {
    await sendConversationDigestEmail({
      to: client.email,
      businessName,
      totalConversations,
      escalatedCount,
      summaryText,
      highlights,
    }).catch((err) => {
      logError('conversation_digest.email_failed', err, { route: 'lib/conversation-digest.ts', clientId: schedule.clientId }, 'warn');
    });
  }

  return { generated: true };
}

/**
 * Sweeps every enabled schedule and generates a digest for the ones
 * that are due. Used by the cron route
 * (GET /api/cron/generate-conversation-digests).
 */
export async function generateDueDigests(): Promise<{ swept: number; generated: number }> {
  const schedules = await prisma.conversationDigestSchedule.findMany({ where: { enabled: true } });
  let generated = 0;
  for (const schedule of schedules) {
    try {
      const outcome = await generateDigestForSchedule(schedule);
      if (outcome.generated) generated += 1;
    } catch (err) {
      logError('conversation_digest.sweep_failed', err, {
        route: 'lib/conversation-digest.ts',
        clientId: schedule.clientId,
      });
    }
  }
  return { swept: schedules.length, generated };
}
