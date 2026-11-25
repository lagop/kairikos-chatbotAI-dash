import 'server-only';
import { NextResponse } from 'next/server';
import type { Prisma, PrismaClient } from '@prisma/client';
import { escapeCsvValue } from './lead-export';
import { toWebStream } from './web-stream';
import type { ExportFormat } from './client-data-audit';

// =============================================================================
// RGPD, encargo del tratamiento (25/11/2026, PR 1 del plan) — las
// conversaciones del chat, para que el cliente se las lleve.
//
// La cláusula 10 del contrato promete que al acabar el servicio el cliente
// recibe en CSV o JSON los datos personales que tratamos por su cuenta, y
// que después se borran. Hasta hoy las conversaciones solo se podían LEER,
// de cincuenta en cincuenta, en /portal/conversations: no había forma de
// llevárselas, y sin eso no se puede borrar nada (PR 4, retención).
//
// Dos formatos, deliberadamente distintos:
//   • CSV, una fila por TURNO: lo abre el cliente en Excel y busca. Una
//     conversación sin turnos legibles sale igual, en una fila con las
//     columnas del turno vacías, para que no desaparezca del recuento.
//   • JSON, un objeto por CONVERSACIÓN con sus turnos dentro: para quien lo
//     va a cargar en otro sistema.
//
// Por páginas de 200 con cursor sobre (startedAt, id) y en streaming: a
// diferencia de las solicitudes (lead-export.ts, acotadas por el tope de
// clasificación), las conversaciones no tienen techo — un widget en una web
// con tráfico hace miles al mes, y cada una lleva su transcript entero. El
// cursor y no `skip`: con `skip` cada página relee todas las anteriores, y
// una conversación que entra mientras se exporta desplazaría la ventana.
//
// Los textos los escriben visitantes anónimos de la web del cliente: TODA
// celda pasa por escapeCsvValue (inyección de fórmulas en Excel, ver su
// comentario). No es teórico: el chat es un formulario abierto a internet.
// =============================================================================

export const CHATBOT_EXPORT_PAGE_SIZE = 200;

const CHANNEL_LABEL: Record<string, string> = {
  web: 'Web',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

const OUTCOME_LABEL: Record<string, string> = {
  resolved: 'Resuelta',
  escalated: 'Derivada',
  abandoned: 'Abandonada',
  fallback: 'Sin respuesta del bot',
  unknown: 'Sin resultado',
};

/** Quién habla en un turno, en palabras del cliente. */
const AUTHOR_LABEL = {
  visitor: 'Visitante',
  bot: 'Asistente',
  staff: 'Persona del negocio',
} as const;
type TurnAuthor = keyof typeof AUTHOR_LABEL;

export const CHATBOT_EXPORT_COLUMNS: ReadonlyArray<{ header: string; key: keyof ChatbotCsvRow }> = Object.freeze([
  { header: 'Conversación', key: 'conversationId' },
  { header: 'Chatbot', key: 'chatbotId' },
  { header: 'Canal', key: 'channel' },
  { header: 'Inicio', key: 'startedAt' },
  { header: 'Última actividad', key: 'lastActivityAt' },
  { header: 'Resultado', key: 'outcome' },
  { header: 'Derivada a una persona', key: 'handoffRequestedAt' },
  { header: 'Atendida por', key: 'handoffTakenBy' },
  { header: 'Turno', key: 'turn' },
  { header: 'Fecha del turno', key: 'turnAt' },
  { header: 'Quién', key: 'author' },
  { header: 'Mensaje', key: 'content' },
]);

/** Las columnas que se leen de ChatbotConversation. Ni `externalSessionId`
 *  (identificador técnico del widget, no le dice nada al cliente) ni las
 *  marcas internas del clasificador. */
export const CHATBOT_EXPORT_SELECT = {
  id: true,
  clientProductId: true,
  channel: true,
  startedAt: true,
  duration: true,
  outcome: true,
  transcript: true,
  handoffRequestedAt: true,
  handoffTakenAt: true,
  handoffTakenBy: true,
  handoffClosedAt: true,
} satisfies Prisma.ChatbotConversationSelect;

export type ChatbotExportConversation = Prisma.ChatbotConversationGetPayload<{ select: typeof CHATBOT_EXPORT_SELECT }>;

export interface ExportTurn {
  at: string | null;
  author: TurnAuthor;
  /** Solo en los turnos de una persona del negocio: quién contestó. */
  agentEmail: string | null;
  content: string;
}

interface ChatbotCsvRow {
  conversationId: string;
  chatbotId: string | null;
  channel: string;
  startedAt: Date;
  lastActivityAt: Date;
  outcome: string;
  handoffRequestedAt: Date | null;
  handoffTakenBy: string | null;
  turn: number | null;
  turnAt: string | null;
  author: string | null;
  content: string | null;
}

/**
 * Última actividad de una conversación: la mayor entre el final según su
 * duración (`startedAt + duration`) y las tres marcas del traspaso. No hay
 * columna para esto y no hace falta: `duration` se refresca en cada turno
 * del bot y en cada respuesta de una persona, y una conversación derivada
 * que nadie contestó tiene al menos la fecha de la derivación.
 *
 * La usa también la retención (PR 4): el plazo cuenta desde aquí.
 */
export function conversationLastActivity(row: {
  startedAt: Date;
  duration: number | null;
  handoffRequestedAt: Date | null;
  handoffTakenAt: Date | null;
  handoffClosedAt: Date | null;
}): Date {
  let last = row.startedAt.getTime() + Math.max(0, row.duration ?? 0) * 1000;
  for (const at of [row.handoffRequestedAt, row.handoffTakenAt, row.handoffClosedAt]) {
    if (at && at.getTime() > last) last = at.getTime();
  }
  return new Date(last);
}

/**
 * Los turnos legibles del transcript, que es un Json libre. Lo real es un
 * array de `{role, content, at}` (lib/chatbot-conversation.ts); los turnos
 * de una persona del negocio llevan además `by: 'agent'` y `agentEmail`
 * (lib/chatbot-handoff.ts). Se acepta también la forma `{messages: [...]}`
 * que leen las vistas antiguas (portal-data.ts), por si quedara alguna fila.
 * Lo que no tenga forma de turno se ignora en vez de romper la exportación.
 */
export function exportTurns(transcript: Prisma.JsonValue | null): ExportTurn[] {
  let entries: unknown[] = [];
  if (Array.isArray(transcript)) entries = transcript;
  else if (transcript && typeof transcript === 'object' && Array.isArray((transcript as { messages?: unknown }).messages)) {
    entries = (transcript as { messages: unknown[] }).messages;
  }

  const turns: ExportTurn[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { role, content, at, by, agentEmail } = entry as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    const staff = role === 'assistant' && by === 'agent';
    turns.push({
      at: typeof at === 'string' ? at : null,
      author: role === 'user' ? 'visitor' : staff ? 'staff' : 'bot',
      agentEmail: staff && typeof agentEmail === 'string' ? agentEmail : null,
      content,
    });
  }
  return turns;
}

function channelLabel(channel: string | null): string {
  if (!channel) return '';
  return CHANNEL_LABEL[channel] ?? channel;
}

function outcomeLabel(outcome: string | null): string {
  if (!outcome) return 'En curso';
  return OUTCOME_LABEL[outcome] ?? outcome;
}

/** Las filas CSV de una conversación: una por turno, o una sola sin turno. */
export function conversationCsvRows(row: ChatbotExportConversation): ChatbotCsvRow[] {
  const base = {
    conversationId: row.id,
    chatbotId: row.clientProductId,
    channel: channelLabel(row.channel),
    startedAt: row.startedAt,
    lastActivityAt: conversationLastActivity(row),
    outcome: outcomeLabel(row.outcome),
    handoffRequestedAt: row.handoffRequestedAt,
    handoffTakenBy: row.handoffTakenBy,
  };
  const turns = exportTurns(row.transcript);
  if (turns.length === 0) {
    return [{ ...base, turn: null, turnAt: null, author: null, content: null }];
  }
  return turns.map((t, i) => ({
    ...base,
    turn: i + 1,
    turnAt: t.at,
    author: t.author === 'staff' && t.agentEmail ? `${AUTHOR_LABEL.staff} (${t.agentEmail})` : AUTHOR_LABEL[t.author],
    content: t.content,
  }));
}

export function csvLine(row: ChatbotCsvRow): string {
  return CHATBOT_EXPORT_COLUMNS.map((c) => escapeCsvValue(row[c.key])).join(',');
}

export function csvHeader(): string {
  return CHATBOT_EXPORT_COLUMNS.map((c) => escapeCsvValue(c.header)).join(',');
}

/** Un objeto por conversación, con sus turnos dentro. Claves en inglés y
 *  valores tal cual están guardados: el JSON es para cargarlo en otro
 *  sistema, el CSV es el que se lee. */
export function conversationJson(row: ChatbotExportConversation) {
  const handoff = row.handoffRequestedAt
    ? {
        requestedAt: row.handoffRequestedAt.toISOString(),
        takenAt: row.handoffTakenAt?.toISOString() ?? null,
        takenBy: row.handoffTakenBy,
        closedAt: row.handoffClosedAt?.toISOString() ?? null,
      }
    : null;
  return {
    id: row.id,
    chatbotId: row.clientProductId,
    channel: row.channel,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: conversationLastActivity(row).toISOString(),
    durationSeconds: row.duration,
    outcome: row.outcome,
    handoff,
    turns: exportTurns(row.transcript),
  };
}

/** Una página tras otra, con cursor sobre (startedAt, id). */
export async function* conversationPages(
  prisma: Pick<PrismaClient, 'chatbotConversation'>,
  clientId: string,
  pageSize: number = CHATBOT_EXPORT_PAGE_SIZE,
): AsyncGenerator<ChatbotExportConversation[]> {
  let cursor: { startedAt: Date; id: string } | null = null;
  for (;;) {
    const where: Prisma.ChatbotConversationWhereInput = cursor
      ? {
          clientId,
          OR: [{ startedAt: { gt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { gt: cursor.id } }],
        }
      : { clientId };
    const page = await prisma.chatbotConversation.findMany({
      where,
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: CHATBOT_EXPORT_SELECT,
    });
    if (page.length === 0) return;
    yield page;
    if (page.length < pageSize) return;
    const last = page[page.length - 1];
    cursor = { startedAt: last.startedAt, id: last.id };
  }
}

const encoder = new TextEncoder();

/**
 * Los bytes del fichero, página a página. El CSV lleva BOM delante (sin él
 * Excel en Windows abre «Peluquería» como «PeluquerÃ­a», ver la ruta de
 * leads) y termina las filas en CRLF. El JSON se escribe a mano alrededor de
 * cada conversación para poder mandarlo por trozos y que siga siendo JSON
 * válido de principio a fin.
 */
export async function* chatbotExportChunks(
  prisma: Pick<PrismaClient, 'chatbotConversation'>,
  clientId: string,
  format: ExportFormat,
  opts: { now?: Date; pageSize?: number } = {},
): AsyncGenerator<Uint8Array> {
  const pages = conversationPages(prisma, clientId, opts.pageSize);
  if (format === 'csv') {
    yield encoder.encode(`﻿${csvHeader()}\r\n`);
    for await (const page of pages) {
      const lines = page.flatMap((row) => conversationCsvRows(row).map(csvLine));
      yield encoder.encode(`${lines.join('\r\n')}\r\n`);
    }
    return;
  }

  const exportedAt = (opts.now ?? new Date()).toISOString();
  yield encoder.encode(`{"product":"chatbot","exportedAt":${JSON.stringify(exportedAt)},"conversations":[`);
  let first = true;
  for await (const page of pages) {
    const parts = page.map((row) => JSON.stringify(conversationJson(row)));
    yield encoder.encode(`${first ? '\n' : ',\n'}${parts.join(',\n')}`);
    first = false;
  }
  yield encoder.encode(`${first ? '' : '\n'}]}\n`);
}

/** `conversaciones-kairikos-2026-11-25.csv` — con la fecha, como las solicitudes. */
export function chatbotExportFilename(format: ExportFormat, now: Date = new Date()): string {
  return `conversaciones-kairikos-${now.toISOString().slice(0, 10)}.${format}`;
}

/** Lo que las dos rutas (cliente y operador) necesitan antes de mandar nada. */
export interface ChatbotExportScope {
  tenantId: string | null;
  /** Conversaciones del cliente: va a la auditoría antes de mandar el fichero. */
  count: number;
  /** Tuvo alguna vez un chatbot contratado, en el estado que sea. */
  everContracted: boolean;
}

/** null si el cliente no existe. */
export async function loadChatbotExportScope(
  prisma: Pick<PrismaClient, 'chatbotClient' | 'chatbotConversation' | 'clientProduct'>,
  clientId: string,
): Promise<ChatbotExportScope | null> {
  const client = await prisma.chatbotClient.findUnique({ where: { id: clientId }, select: { tenantId: true } });
  if (!client) return null;
  const [count, contract] = await Promise.all([
    prisma.chatbotConversation.count({ where: { clientId } }),
    prisma.clientProduct.findFirst({ where: { clientId, product: { code: 'chatbot' } }, select: { id: true } }),
  ]);
  return { tenantId: client.tenantId, count, everContracted: contract !== null };
}

/** La respuesta de descarga, común a las dos rutas. */
export function chatbotExportResponse(
  prisma: Pick<PrismaClient, 'chatbotConversation'>,
  clientId: string,
  format: ExportFormat,
  onError: (err: unknown) => void,
  now: Date = new Date(),
): NextResponse {
  return new NextResponse(toWebStream(chatbotExportChunks(prisma, clientId, format, { now }), onError), {
    status: 200,
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${chatbotExportFilename(format, now)}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
