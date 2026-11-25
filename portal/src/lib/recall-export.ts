import 'server-only';
import { NextResponse } from 'next/server';
import type { Prisma, PrismaClient } from '@prisma/client';
import { escapeCsvValue } from './lead-export';
import { toWebStream } from './web-stream';
import type { ExportFormat } from './client-data-audit';

// =============================================================================
// RGPD, encargo del tratamiento (25/11/2026, PR 2 del plan) — los registros
// de llamadas de una línea (`CallEvent`), para que el cliente se los lleve.
//
// Mismo molde que lib/chatbot-export.ts: CSV con BOM y cada celda por
// escapeCsvValue (la transcripción es lo que dijo un desconocido al teléfono,
// y un «igual» al principio de una frase es una fórmula en Excel), JSON con
// claves en inglés, por páginas con cursor sobre (startedAt, id) y en
// streaming.
//
// La GRABACIÓN no sale, ni su URL. Lo que se exporta es su estado:
// «disponible» o «borrada el …». La URL es de Twilio, autenticada con
// NUESTRA cuenta: no le sirve al cliente fuera del portal, y en un fichero
// que se reenvía por correo es justo lo que no debe viajar. El audio se borra
// en Twilio a los 30 días (lib/recall-retention.ts); la transcripción, el
// número y el resultado se guardan mientras el servicio esté contratado.
//
// Lo que tampoco sale: los errores internos de envío y transcripción, los
// contadores de reintentos y los identificadores de Twilio. Son de nuestra
// operación, no datos del cliente.
// =============================================================================

export const RECALL_EXPORT_PAGE_SIZE = 200;

/** Mismas palabras que /portal/llamadas, más los que allí no se listan. */
const OUTCOME_LABEL: Record<string, string> = {
  recorded: 'Dejó un recado',
  no_message: 'Colgó sin dejar recado',
  withheld: 'Número oculto',
  blocked: 'Número bloqueado por ti',
  pending: 'En curso',
};

const NOTIFY_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  sms_fallback: 'SMS',
  throttled: 'No: ya le habíamos escrito ese día',
  blocked: 'No: número bloqueado por ti',
  unreachable: 'No: no pudimos escribirle',
};

const LANGUAGE_LABEL: Record<string, string> = {
  es: 'Español',
  en: 'Inglés',
  de: 'Alemán',
};

export const RECALL_EXPORT_SELECT = {
  id: true,
  startedAt: true,
  endedAt: true,
  fromNumber: true,
  withheld: true,
  toNumber: true,
  outcome: true,
  recordingSid: true,
  recordingDurationSeconds: true,
  recordingDeletedAt: true,
  transcript: true,
  callerNotifyChannel: true,
  legalNoticeVersion: true,
  legalNoticeSentAt: true,
  callerLanguage: true,
  callbackSlotAt: true,
} satisfies Prisma.CallEventSelect;

export type RecallExportCall = Prisma.CallEventGetPayload<{ select: typeof RECALL_EXPORT_SELECT }>;

export const RECALL_EXPORT_COLUMNS: ReadonlyArray<{ header: string; key: keyof RecallCsvRow }> = Object.freeze([
  { header: 'Fecha', key: 'startedAt' },
  { header: 'Fin', key: 'endedAt' },
  { header: 'Número de quien llamó', key: 'from' },
  { header: 'Número marcado', key: 'to' },
  { header: 'Resultado', key: 'outcome' },
  { header: 'Duración del recado (s)', key: 'messageSeconds' },
  { header: 'Transcripción', key: 'transcript' },
  { header: 'Grabación', key: 'recording' },
  { header: 'Aviso a quien llamó', key: 'callerNotice' },
  { header: 'Versión del aviso legal', key: 'legalNoticeVersion' },
  { header: 'Aviso legal enviado', key: 'legalNoticeSentAt' },
  { header: 'Idioma', key: 'language' },
  { header: 'Devolución agendada', key: 'callbackSlotAt' },
]);

interface RecallCsvRow {
  startedAt: Date;
  endedAt: Date | null;
  from: string;
  to: string;
  outcome: string;
  messageSeconds: number | null;
  transcript: string | null;
  recording: string;
  callerNotice: string;
  legalNoticeVersion: string | null;
  legalNoticeSentAt: Date | null;
  language: string;
  callbackSlotAt: Date | null;
}

export type RecordingState = 'none' | 'available' | 'deleted';

/** Nunca la URL: solo si hubo grabación y si sigue existiendo. */
export function recordingState(call: Pick<RecallExportCall, 'recordingSid' | 'recordingDeletedAt'>): RecordingState {
  if (call.recordingDeletedAt) return 'deleted';
  return call.recordingSid ? 'available' : 'none';
}

function recordingLabel(call: RecallExportCall): string {
  switch (recordingState(call)) {
    case 'deleted':
      return `borrada el ${call.recordingDeletedAt!.toISOString().slice(0, 10)}`;
    case 'available':
      return 'disponible';
    default:
      return 'sin grabación';
  }
}

/** Oculto cuando quien llamó ocultó su número: no hay nada que devolver. */
function callerNumber(call: Pick<RecallExportCall, 'fromNumber' | 'withheld'>): string | null {
  return call.withheld || !call.fromNumber ? null : call.fromNumber;
}

export function callCsvRow(call: RecallExportCall): RecallCsvRow {
  return {
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    from: callerNumber(call) ?? 'Oculto',
    to: call.toNumber,
    outcome: OUTCOME_LABEL[call.outcome] ?? call.outcome,
    messageSeconds: call.recordingDurationSeconds,
    transcript: call.transcript,
    recording: recordingLabel(call),
    callerNotice: call.callerNotifyChannel ? NOTIFY_LABEL[call.callerNotifyChannel] ?? call.callerNotifyChannel : '',
    legalNoticeVersion: call.legalNoticeVersion,
    legalNoticeSentAt: call.legalNoticeSentAt,
    language: call.callerLanguage ? LANGUAGE_LABEL[call.callerLanguage] ?? call.callerLanguage : '',
    callbackSlotAt: call.callbackSlotAt,
  };
}

export function csvHeader(): string {
  return RECALL_EXPORT_COLUMNS.map((c) => escapeCsvValue(c.header)).join(',');
}

export function csvLine(row: RecallCsvRow): string {
  return RECALL_EXPORT_COLUMNS.map((c) => escapeCsvValue(row[c.key])).join(',');
}

/** Un objeto por llamada, con los valores tal cual están guardados. */
export function callJson(call: RecallExportCall) {
  const state = recordingState(call);
  return {
    id: call.id,
    startedAt: call.startedAt.toISOString(),
    endedAt: call.endedAt?.toISOString() ?? null,
    from: callerNumber(call),
    withheld: call.withheld || !call.fromNumber,
    to: call.toNumber,
    outcome: call.outcome,
    messageSeconds: call.recordingDurationSeconds,
    transcript: call.transcript,
    recording: {
      state,
      deletedAt: state === 'deleted' ? call.recordingDeletedAt!.toISOString() : null,
    },
    callerNotifyChannel: call.callerNotifyChannel,
    legalNoticeVersion: call.legalNoticeVersion,
    legalNoticeSentAt: call.legalNoticeSentAt?.toISOString() ?? null,
    callerLanguage: call.callerLanguage,
    callbackSlotAt: call.callbackSlotAt?.toISOString() ?? null,
  };
}

/** Una página tras otra, con cursor sobre (startedAt, id). */
export async function* callPages(
  prisma: Pick<PrismaClient, 'callEvent'>,
  subscriptionId: string,
  pageSize: number = RECALL_EXPORT_PAGE_SIZE,
): AsyncGenerator<RecallExportCall[]> {
  let cursor: { startedAt: Date; id: string } | null = null;
  for (;;) {
    const where: Prisma.CallEventWhereInput = cursor
      ? {
          subscriptionId,
          OR: [{ startedAt: { gt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { gt: cursor.id } }],
        }
      : { subscriptionId };
    const page = await prisma.callEvent.findMany({
      where,
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: RECALL_EXPORT_SELECT,
    });
    if (page.length === 0) return;
    yield page;
    if (page.length < pageSize) return;
    const last = page[page.length - 1];
    cursor = { startedAt: last.startedAt, id: last.id };
  }
}

const encoder = new TextEncoder();

export async function* recallExportChunks(
  prisma: Pick<PrismaClient, 'callEvent'>,
  subscriptionId: string,
  format: ExportFormat,
  opts: { now?: Date; pageSize?: number; line?: string | null } = {},
): AsyncGenerator<Uint8Array> {
  const pages = callPages(prisma, subscriptionId, opts.pageSize);
  if (format === 'csv') {
    yield encoder.encode(`﻿${csvHeader()}\r\n`);
    for await (const page of pages) {
      yield encoder.encode(`${page.map((call) => csvLine(callCsvRow(call))).join('\r\n')}\r\n`);
    }
    return;
  }

  const exportedAt = (opts.now ?? new Date()).toISOString();
  yield encoder.encode(
    `{"product":"recall","exportedAt":${JSON.stringify(exportedAt)},"line":${JSON.stringify(opts.line ?? null)},"calls":[`,
  );
  let first = true;
  for await (const page of pages) {
    yield encoder.encode(`${first ? '\n' : ',\n'}${page.map((call) => JSON.stringify(callJson(call))).join(',\n')}`);
    first = false;
  }
  yield encoder.encode(`${first ? '' : '\n'}]}\n`);
}

/** `llamadas-kairikos-2026-11-25.csv` */
export function recallExportFilename(format: ExportFormat, now: Date = new Date()): string {
  return `llamadas-kairikos-${now.toISOString().slice(0, 10)}.${format}`;
}

export interface RecallExportScope {
  subscriptionId: string;
  clientId: string;
  clientProductId: string;
  tenantId: string | null;
  /** El número virtual de la línea, para que el JSON diga de cuál es. */
  line: string | null;
  count: number;
}

/** null si la suscripción no existe. */
export async function loadRecallExportScope(
  prisma: Pick<PrismaClient, 'recallSubscription' | 'callEvent'>,
  subscriptionId: string,
): Promise<RecallExportScope | null> {
  const sub = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, clientId: true, clientProductId: true, tenantId: true, virtualNumber: { select: { e164: true } } },
  });
  if (!sub) return null;
  const count = await prisma.callEvent.count({ where: { subscriptionId: sub.id } });
  return {
    subscriptionId: sub.id,
    clientId: sub.clientId,
    clientProductId: sub.clientProductId,
    tenantId: sub.tenantId,
    line: sub.virtualNumber?.e164 ?? null,
    count,
  };
}

export function recallExportResponse(
  prisma: Pick<PrismaClient, 'callEvent'>,
  scope: RecallExportScope,
  format: ExportFormat,
  onError: (err: unknown) => void,
  now: Date = new Date(),
): NextResponse {
  return new NextResponse(toWebStream(recallExportChunks(prisma, scope.subscriptionId, format, { now, line: scope.line }), onError), {
    status: 200,
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${recallExportFilename(format, now)}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
