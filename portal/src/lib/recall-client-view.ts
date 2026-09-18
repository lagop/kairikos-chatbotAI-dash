import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  computeMonthlyMetrics,
  localMonthFor,
  monthBounds,
  shiftLocalMonth,
  type MonthlyMetrics,
} from './recall-reports';
import { RECORDING_RETENTION_DAYS } from './recall-retention';

// =============================================================================
// WP-XX — what a 'recall' client sees when they choose to log in.
//
// READ-ONLY, and that is a design constraint rather than a phase-one
// shortcut. The owner decides which calls became a job by REPLYING TO THE
// 19:00 DIGEST, and that reply is what writes
// RecallDigest.selectedCallEventIds, which in turn decides who gets asked
// for a Google review. A second place to make that same decision would
// give one decision two writers, and they would disagree — in the half of
// the product that has a policy dimension.
//
// So: the portal shows, WhatsApp decides.
//
// The product still never REQUIRES a login. A plumber runs this entirely
// from the WhatsApp he already has open; this page exists for the once or
// twice a month he wants to see the numbers himself — and, not
// incidentally, for the portal home to be able to show him the rest of
// the catalogue while he is there.
//
// Every figure comes from computeMonthlyMetrics, the SAME function that
// builds the WhatsApp monthly report. Recomputing them here would let the
// portal and the message he already received disagree in front of him.
// =============================================================================

/** How many months of history the client sees. A year is enough to show a
 *  trend and short enough that the page stays one screen. */
export const HISTORY_MONTHS = 12;

/** Calls per page. Sized for a phone: about a screenful of cards once
 *  transcripts are included, and small enough that page one answers
 *  "what came in these last few days" without sending down a month. */
export const CALLS_PER_PAGE = 20;

export interface RecallCallSummary {
  id: string;
  startedAt: Date;
  fromNumber: string | null;
  withheld: boolean;
  outcome: string;
  transcript: string | null;
  /** 'whatsapp' | 'sms' | 'blocked' | 'throttled' | 'unreachable' | null */
  callerNotifyChannel: string | null;
  notifiedCallerAt: Date | null;
  /** Fase 3 — cuándo se ha comprometido devolverle la llamada, si eligió
   *  hueco. NULL si no se le ofrecieron opciones o no contestó. */
  callbackSlotAt: Date | null;
}

export interface RecallMonthSummary {
  localMonth: string;
  calls: number;
  recordedCalls: number;
  minutes: number;
  reviewRequests: number;
  /** The month currently on screen. The page renders it unlinked and
   *  marked, rather than removing it from the list. */
  isSelected: boolean;
}

/** 2026-09-16 — con `status`: antes solo se pasaba el número, y la tarjeta
 *  decía "WhatsApp conectado" a un cliente cuyo acceso había caducado dos
 *  días antes, sin ofrecerle forma de reconectar. */
export interface RecallMetaConnectionSummary {
  displayPhoneNumber: string | null;
  /** 'active' | 'needs_reconnect' | 'revoked' */
  status: string;
}

export interface RecallLineOption {
  clientProductId: string;
  /** El número virtual de esa línea, que es como el cliente la reconoce.
   *  Nulo mientras el alta no tenga número asignado todavía. */
  virtualNumber: string | null;
  status: string;
}

export type RecallClientView =
  | { state: 'not_contracted' }
  // Fase 3 multi-instancia — varias líneas y ninguna elegida. Trae qué
  // elegir para que la página no tenga que volver a consultarlo.
  | { state: 'pick_line'; lines: RecallLineOption[] }
  /** Contracted and paid, but the service is not answering calls yet —
   *  usually waiting on the client to set up the divert on his own line.
   *  Showing an empty dashboard here would read as "we sold you nothing". */
  | {
      state: 'onboarding';
      status: string;
      since: Date;
      virtualNumber: string | null;
      /** Fase 8 — null until the Coexistence connect completes. Once set,
       *  the onboarding page shows this instead of the connect button —
       *  there is nothing to disconnect and reconnect here (see
       *  RecallMetaConnectCard's header). */
      metaConnection: RecallMetaConnectionSummary | null;
    }
  | {
      state: 'active';
      virtualNumber: string | null;
      /** The month being viewed, 'YYYY-MM' in the client's timezone. */
      localMonth: string;
      /** Neighbouring months inside the range that has data, or null at
       *  either end. The page renders these as its only navigation. */
      previousMonth: string | null;
      nextMonth: string | null;
      /** Always computed live for whichever month is shown, so a past
       *  month and the current one are produced the same way. */
      metrics: MonthlyMetrics;
      /** Null until the client connects their Google Business Profile —
       *  see RecallGoogleConnectCard's header for why this binding was
       *  missing for the product's whole life until now. */
      googleConnection: { locationName: string; status: string } | null;
      /** El WhatsApp del negocio y si sigue vivo. Con el servicio activo solo
       *  se enseña cuando hay que reconectar — ver /portal/llamadas. */
      metaConnection: RecallMetaConnectionSummary | null;
      /** Every OTHER month, as the table that doubles as navigation. */
      history: RecallMonthSummary[];
      /** Just this page of the month, newest first. */
      calls: RecallCallSummary[];
      /** 1-based. Always inside [1, pageCount]. */
      page: number;
      pageCount: number;
      /** Every call in the month, so the page can say "21-40 de 47"
       *  instead of leaving the reader to guess what is off-screen. */
      totalCalls: number;
      pageSize: number;
      recordingRetentionDays: number;
    };

/**
 * Load one client's own view of their recall service.
 *
 * Scoped by clientId at every step — this is the only place in the
 * product where recall data is read on behalf of the end client rather
 * than an operator, so nothing here may take an id from anywhere but the
 * session.
 *
 * Fase 3 multi-instancia — `recall` SÍ es exento desde
 * 20260929090000_recall_multi_line: un cliente puede tener una línea por
 * negocio. Este comentario decía lo contrario y era cierto hasta entonces.
 *
 * `clientProductId` dice de qué línea se está hablando. Omitirlo significa
 * "la única que haya": con una devuelve esa —el caso de todos los clientes de
 * hoy, y por eso la página no cambia— y con varias devuelve
 * `state: 'pick_line'` en vez de elegir una al azar. El `orderBy` de antes
 * hacía la elección determinista, pero no por ello correcta: "la más
 * reciente" no es la que el cliente estaba mirando.
 */
export async function loadRecallClientView(
  prisma: PrismaClient,
  clientId: string,
  opts: {
    now?: Date;
    month?: string | null;
    page?: string | number | null;
    clientProductId?: string | null;
  } = {},
): Promise<RecallClientView> {
  const now = opts.now ?? new Date();

  // Se piden DOS para poder distinguir "no hay" de "hay varias y no sé cuál".
  const subscriptions = await prisma.recallSubscription.findMany({
    where: {
      clientId,
      ...(opts.clientProductId ? { clientProductId: opts.clientProductId } : {}),
    },
    take: 2,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      clientId: true,
      clientProductId: true,
      status: true,
      createdAt: true,
      activatedAt: true,
      timezone: true,
      googleConnectionId: true,
      virtualNumber: { select: { e164: true } },
      metaConnection: { select: { displayPhoneNumber: true, status: true } },
      googleConnection: { select: { locationName: true, status: true } },
    },
  });

  if (subscriptions.length === 0) return { state: 'not_contracted' };
  if (subscriptions.length > 1) {
    // Varias líneas y ninguna elegida: la página ofrece elegir. Negarse a
    // adivinar es lo correcto — enseñar los recados de la línea equivocada
    // no se nota hasta que alguien llama a quien no debía.
    //
    // Se vuelven a pedir todas (el take: 2 de arriba solo servía para saber
    // si había ambigüedad) porque el selector las necesita enteras.
    const all = await prisma.recallSubscription.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
      select: {
        clientProductId: true,
        status: true,
        virtualNumber: { select: { e164: true } },
      },
    });
    return {
      state: 'pick_line',
      lines: all.map((row) => ({
        clientProductId: row.clientProductId,
        virtualNumber: row.virtualNumber?.e164 ?? null,
        status: row.status,
      })),
    };
  }
  const subscription = subscriptions[0];

  const virtualNumber = subscription.virtualNumber?.e164 ?? null;

  // 'paused' and 'cancelled' land here too: a client who stopped the
  // service should see why rather than an empty dashboard implying it is
  // still running.
  if (subscription.status !== 'active') {
    return {
      state: 'onboarding',
      status: subscription.status,
      since: subscription.activatedAt ?? subscription.createdAt,
      virtualNumber,
      metaConnection: subscription.metaConnection
        ? {
            displayPhoneNumber: subscription.metaConnection.displayPhoneNumber,
            status: subscription.metaConnection.status,
          }
        : null,
    };
  }

  const currentMonth = localMonthFor(now, subscription.timezone);

  // The earliest month worth offering: whatever the roll-up has, or
  // this month when it has nothing yet. Without a floor the previous
  // arrow would walk backwards forever through empty months.
  const earliestRow = await prisma.recallUsageMonth.findFirst({
    where: { subscriptionId: subscription.id },
    orderBy: { localMonth: 'asc' },
    select: { localMonth: true },
  });
  const earliestMonth =
    earliestRow && earliestRow.localMonth < currentMonth ? earliestRow.localMonth : currentMonth;

  // The month key arrives from the query string, so it is validated and
  // clamped rather than trusted: a malformed or out-of-range value must
  // land somewhere real instead of rendering an empty month.
  const localMonth = clampMonth(opts.month, earliestMonth, currentMonth);
  const { since, until } = monthBounds(localMonth, subscription.timezone);

  const previousMonth = localMonth > earliestMonth ? shiftLocalMonth(localMonth, -1) : null;
  const nextMonth = localMonth < currentMonth ? shiftLocalMonth(localMonth, 1) : null;

  const callWhere = {
    subscriptionId: subscription.id,
    startedAt: { gte: since, lt: until },
    // A blocked caller is one the client asked us to silence. Listing
    // them back to him is noise about a decision he already made.
    outcome: { not: 'blocked' },
  };

  const [metrics, historyRows, totalCalls] = await Promise.all([
    computeMonthlyMetrics(prisma, subscription, since, until),
    prisma.recallUsageMonth.findMany({
      // EVERY month, including the one on screen: this table is the
      // navigation, and a list that drops its own selected row
      // reshuffles under the reader every time they use it.
      where: { subscriptionId: subscription.id },
      orderBy: { localMonth: 'desc' },
      take: HISTORY_MONTHS,
      select: {
        localMonth: true,
        calls: true,
        recordedCalls: true,
        callSeconds: true,
        reviewRequests: true,
      },
    }),
    prisma.callEvent.count({ where: callWhere }),
  ]);

  // Clamped only once the total is known, so ?p=99 on a two-page month
  // lands on page two rather than on an empty list that would read as
  // "you had no calls".
  const pageCount = Math.max(1, Math.ceil(totalCalls / CALLS_PER_PAGE));
  const page = clampPage(opts.page, pageCount);

  const callRows = await prisma.callEvent.findMany({
    where: callWhere,
    orderBy: { startedAt: 'desc' },
    skip: (page - 1) * CALLS_PER_PAGE,
    take: CALLS_PER_PAGE,
    select: {
      id: true,
      startedAt: true,
      fromNumber: true,
      withheld: true,
      outcome: true,
      transcript: true,
      callerNotifyChannel: true,
      notifiedCallerAt: true,
      callbackSlotAt: true,
    },
  });

  return {
    state: 'active',
    virtualNumber,
    localMonth,
    previousMonth,
    nextMonth,
    metrics,
    googleConnection: subscription.googleConnection
      ? { locationName: subscription.googleConnection.locationName, status: subscription.googleConnection.status }
      : null,
    metaConnection: subscription.metaConnection
      ? {
          displayPhoneNumber: subscription.metaConnection.displayPhoneNumber,
          status: subscription.metaConnection.status,
        }
      : null,
    history: buildHistory(historyRows, localMonth, metrics),
    calls: callRows,
    page,
    pageCount,
    totalCalls,
    pageSize: CALLS_PER_PAGE,
    // Surfaced rather than hard-coded in the page so the number the client
    // is told always matches the number the purge job actually enforces.
    recordingRetentionDays: RECORDING_RETENTION_DAYS,
  };
}

interface UsageRow {
  localMonth: string;
  calls: number;
  recordedCalls: number;
  callSeconds: number;
  reviewRequests: number;
}

/**
 * The month list, newest first, with the selected month always present.
 *
 * Its figures come from the LIVE metrics rather than from its roll-up
 * row, so the row and the summary above it can never show two numbers
 * for the same month. The other rows are the stored roll-up, which for
 * a month that isn't on screen is exactly what it should be — and for
 * the current month, when some other month is selected, lags by at most
 * one scheduler tick.
 *
 * The selected month is synthesised when no roll-up row exists yet,
 * which is the normal state of a month that started this morning.
 */
export function buildHistory(
  rows: readonly UsageRow[],
  selectedMonth: string,
  metrics: { calls: number; recordedCalls: number; callSeconds: number; reviewRequests: number },
): RecallMonthSummary[] {
  const mapped = rows.map((row) => ({
    localMonth: row.localMonth,
    calls: row.calls,
    recordedCalls: row.recordedCalls,
    minutes: Math.round(row.callSeconds / 60),
    reviewRequests: row.reviewRequests,
    isSelected: false,
  }));

  const selected: RecallMonthSummary = {
    localMonth: selectedMonth,
    calls: metrics.calls,
    recordedCalls: metrics.recordedCalls,
    minutes: Math.round(metrics.callSeconds / 60),
    reviewRequests: metrics.reviewRequests,
    isSelected: true,
  };

  const withoutSelected = mapped.filter((row) => row.localMonth !== selectedMonth);
  return [...withoutSelected, selected].sort((a, b) => (a.localMonth < b.localMonth ? 1 : -1));
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Read a month key off the query string.
 *
 * Anything unparseable, or outside the range that actually has data,
 * falls back to the newest month. A URL is user input: the failure mode
 * to avoid is an empty page that looks like "you had no calls" when it
 * really means "that month never existed".
 */
/**
 * Read a page number off the query string.
 *
 * Same posture as clampMonth: a URL is user input, and the failure to
 * avoid is an empty list that reads as "you had no calls" when it
 * really means "that page does not exist".
 */
export function clampPage(requested: string | number | null | undefined, pageCount: number): number {
  const parsed = typeof requested === 'number' ? requested : Number.parseInt(String(requested ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.trunc(parsed), Math.max(1, pageCount));
}

export function clampMonth(
  requested: string | null | undefined,
  earliest: string,
  latest: string,
): string {
  if (!requested || !MONTH_KEY.test(requested)) return latest;
  if (requested < earliest) return earliest;
  if (requested > latest) return latest;
  return requested;
}
