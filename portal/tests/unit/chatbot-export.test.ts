// =============================================================================
// RGPD (25/11/2026, PR 1 del plan del encargo) — exportación de las
// conversaciones del chat y su auditoría.
//
// Lo que no puede pasar: que un texto de un visitante se ejecute como fórmula
// al abrir el CSV, que Excel rompa los acentos, que el JSON salga inválido
// por mandarse a trozos, que se pierdan conversaciones entre páginas, que un
// cliente se lleve las de otro cambiando la URL, o que la auditoría guarde
// datos personales (o que haya fichero sin auditoría).
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  authenticateAdminRequest: vi.fn(),
  hasLeadsInboxAccess: vi.fn(),
  clientFindUnique: vi.fn(),
  conversationCount: vi.fn(),
  conversationFindMany: vi.fn(),
  clientProductFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  leadFindMany: vi.fn(),
  leadCount: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatbotClient: { findUnique: (...a: unknown[]) => state.clientFindUnique(...a) },
    chatbotConversation: {
      count: (...a: unknown[]) => state.conversationCount(...a),
      findMany: (...a: unknown[]) => state.conversationFindMany(...a),
    },
    clientProduct: { findFirst: (...a: unknown[]) => state.clientProductFindFirst(...a) },
    clientDataAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
    lead: {
      findMany: (...a: unknown[]) => state.leadFindMany(...a),
      count: (...a: unknown[]) => state.leadCount(...a),
    },
  },
}));
vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => state.getSession(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => state.resolveClientFromSession(...a),
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => state.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/leads', () => ({ hasLeadsInboxAccess: (...a: unknown[]) => state.hasLeadsInboxAccess(...a) }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => state.logError(...a) }));

import {
  chatbotExportChunks,
  conversationLastActivity,
  exportTurns,
  type ChatbotExportConversation,
} from '@/lib/chatbot-export';
import { parseExportFormat } from '@/lib/client-data-audit';
import { GET as clientGet } from '@/app/api/portal/conversations/export/route';
import { GET as adminGet } from '@/app/api/admin/portal/conversations/export/route';
import { GET as leadsGet } from '@/app/api/portal/leads/export/route';

const T0 = new Date('2026-11-20T10:00:00.000Z');

function conv(over: Partial<ChatbotExportConversation> = {}): ChatbotExportConversation {
  return {
    id: 'conv_1',
    clientProductId: '11111111-1111-4111-8111-111111111111',
    channel: 'web',
    startedAt: T0,
    duration: 120,
    outcome: 'resolved',
    transcript: [
      { role: 'user', content: 'Hola, soy Ana, mi teléfono es 600 000 000', at: '2026-11-20T10:00:00.000Z' },
      { role: 'assistant', content: '¡Hola Ana! ¿En qué te ayudo?', at: '2026-11-20T10:00:05.000Z' },
    ],
    handoffRequestedAt: null,
    handoffTakenAt: null,
    handoffTakenBy: null,
    handoffClosedAt: null,
    ...over,
  };
}

async function readAll(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let out = '';
  for await (const chunk of gen) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/** Un findMany que sirve `rows` por páginas respetando el cursor. */
function pagedFindMany(rows: ChatbotExportConversation[]) {
  return async (args: { where: Record<string, unknown>; take: number }) => {
    const sorted = [...rows].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
    const or = args.where.OR as Array<Record<string, unknown>> | undefined;
    let start = 0;
    if (or) {
      const gt = (or[0].startedAt as { gt: Date }).gt;
      const sameId = (or[1].id as { gt: string }).gt;
      start = sorted.findIndex((r) => r.startedAt > gt || (r.startedAt.getTime() === gt.getTime() && r.id > sameId));
      if (start < 0) return [];
    }
    return sorted.slice(start, start + args.take);
  };
}

const prismaLike = () => ({
  chatbotConversation: {
    findMany: (...a: unknown[]) => state.conversationFindMany(...a),
    count: (...a: unknown[]) => state.conversationCount(...a),
  },
}) as never;

function clientReq(query = '') {
  return new NextRequest(`http://localhost/api/portal/conversations/export${query}`);
}
function adminReq(query = '') {
  return new NextRequest(`http://localhost/api/admin/portal/conversations/export${query}`);
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.getSession.mockResolvedValue({ hasClientAccess: true });
  state.resolveClientFromSession.mockResolvedValue({ clientId: 'client_a', email: 'a@example.com', source: 'database' });
  state.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  state.clientFindUnique.mockResolvedValue({ tenantId: '22222222-2222-4222-8222-222222222222' });
  state.conversationCount.mockResolvedValue(1);
  state.clientProductFindFirst.mockResolvedValue({ id: 'cp_chat' });
  state.conversationFindMany.mockImplementation(pagedFindMany([conv()]));
  state.auditCreate.mockResolvedValue({});
  state.hasLeadsInboxAccess.mockResolvedValue(true);
  state.leadCount.mockResolvedValue(0);
});

describe('exportTurns', () => {
  it('lee el array real, distingue visitante, bot y persona del negocio, e ignora lo que no es un turno', () => {
    const turns = exportTurns([
      { role: 'user', content: 'Hola', at: '2026-11-20T10:00:00.000Z' },
      { role: 'assistant', content: 'Buenas', at: '2026-11-20T10:00:01.000Z' },
      { role: 'assistant', content: 'Soy Marta, te llamo', at: '2026-11-20T10:05:00.000Z', by: 'agent', agentEmail: 'marta@negocio.es' },
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 42 },
      'basura',
      null,
    ]);
    expect(turns.map((t) => t.author)).toEqual(['visitor', 'bot', 'staff']);
    expect(turns[2].agentEmail).toBe('marta@negocio.es');
    expect(turns[0].agentEmail).toBeNull();
  });

  it('acepta también la forma antigua {messages: [...]} y un transcript vacío', () => {
    expect(exportTurns({ messages: [{ role: 'user', content: 'x' }] })).toHaveLength(1);
    expect(exportTurns(null)).toEqual([]);
    expect(exportTurns('texto' as never)).toEqual([]);
  });
});

describe('conversationLastActivity', () => {
  it('es startedAt + duración si no hubo derivación', () => {
    expect(conversationLastActivity(conv({ duration: 90 })).toISOString()).toBe('2026-11-20T10:01:30.000Z');
  });

  it('una derivación posterior gana, y una duración nula cuenta como cero', () => {
    const closed = new Date('2026-11-22T09:00:00.000Z');
    expect(
      conversationLastActivity(conv({ duration: null, handoffRequestedAt: new Date('2026-11-20T10:02:00.000Z'), handoffClosedAt: closed })),
    ).toEqual(closed);
    expect(conversationLastActivity(conv({ duration: null }))).toEqual(T0);
  });
});

describe('CSV', () => {
  it('lleva BOM, cabecera en castellano y una fila por turno en CRLF', async () => {
    const csv = await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'csv'));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Conversación,Chatbot,Canal,Inicio,Última actividad,Resultado,Derivada a una persona,Atendida por,Turno,Fecha del turno,Quién,Mensaje',
    );
    expect(lines).toHaveLength(4); // cabecera, dos turnos y la línea vacía final
    expect(lines[1]).toContain(',Web,2026-11-20T10:00:00.000Z,2026-11-20T10:02:00.000Z,Resuelta,,,1,');
    expect(lines[1]).toContain('Visitante');
    expect(lines[2]).toContain('Asistente');
  });

  it('neutraliza fórmulas y entrecomilla comas, comillas y saltos: el texto lo escribe un visitante', async () => {
    state.conversationFindMany.mockImplementation(
      pagedFindMany([
        conv({
          transcript: [
            { role: 'user', content: '=HYPERLINK("http://malo.example","pincha")', at: '2026-11-20T10:00:00.000Z' },
            { role: 'user', content: '+34 600, línea 1\nlínea 2', at: '2026-11-20T10:00:01.000Z' },
            { role: 'user', content: '@SUM(1)', at: '2026-11-20T10:00:02.000Z' },
          ],
        }),
      ]),
    );
    const csv = await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'csv'));
    expect(csv).toContain(`"'=HYPERLINK(""http://malo.example"",""pincha"")"`);
    expect(csv).toContain(`"'+34 600, línea 1\nlínea 2"`);
    expect(csv).toContain(`'@SUM(1)`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('una conversación sin turnos legibles sale igual, en una fila con el turno vacío', async () => {
    state.conversationFindMany.mockImplementation(pagedFindMany([conv({ transcript: null, outcome: null, channel: null })]));
    const lines = (await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'csv'))).slice(1).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^conv_1,.*,En curso,,,,,,$/);
  });

  it('una persona del negocio sale con su correo', async () => {
    state.conversationFindMany.mockImplementation(
      pagedFindMany([conv({ transcript: [{ role: 'assistant', content: 'Te llamo', by: 'agent', agentEmail: 'marta@negocio.es' }] })]),
    );
    const csv = await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'csv'));
    expect(csv).toContain('Persona del negocio (marta@negocio.es)');
  });
});

describe('JSON', () => {
  it('un objeto por conversación, con sus turnos dentro, y JSON válido de principio a fin', async () => {
    const handoff = new Date('2026-11-20T10:03:00.000Z');
    state.conversationFindMany.mockImplementation(
      pagedFindMany([conv(), conv({ id: 'conv_2', handoffRequestedAt: handoff, handoffTakenBy: 'marta@negocio.es', outcome: 'escalated' })]),
    );
    const now = new Date('2026-11-25T08:00:00.000Z');
    const parsed = JSON.parse(await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'json', { now })));
    expect(parsed.product).toBe('chatbot');
    expect(parsed.exportedAt).toBe('2026-11-25T08:00:00.000Z');
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations[0]).toEqual({
      id: 'conv_1',
      chatbotId: '11111111-1111-4111-8111-111111111111',
      channel: 'web',
      startedAt: '2026-11-20T10:00:00.000Z',
      lastActivityAt: '2026-11-20T10:02:00.000Z',
      durationSeconds: 120,
      outcome: 'resolved',
      handoff: null,
      turns: [
        { at: '2026-11-20T10:00:00.000Z', author: 'visitor', agentEmail: null, content: 'Hola, soy Ana, mi teléfono es 600 000 000' },
        { at: '2026-11-20T10:00:05.000Z', author: 'bot', agentEmail: null, content: '¡Hola Ana! ¿En qué te ayudo?' },
      ],
    });
    expect(parsed.conversations[1].handoff).toEqual({
      requestedAt: '2026-11-20T10:03:00.000Z',
      takenAt: null,
      takenBy: 'marta@negocio.es',
      closedAt: null,
    });
    expect(parsed.conversations[1].lastActivityAt).toBe('2026-11-20T10:03:00.000Z');
  });

  it('sin conversaciones también es JSON válido', async () => {
    state.conversationFindMany.mockResolvedValue([]);
    const parsed = JSON.parse(await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'json')));
    expect(parsed.conversations).toEqual([]);
  });
});

describe('paginación por cursor', () => {
  it('recorre todas las páginas sin repetir ni saltarse ninguna, también con fechas iguales', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      conv({ id: `conv_${i}`, startedAt: new Date(T0.getTime() + Math.floor(i / 2) * 1000) }),
    );
    state.conversationFindMany.mockImplementation(pagedFindMany(rows));
    const parsed = JSON.parse(await readAll(chatbotExportChunks(prismaLike(), 'client_a', 'json', { pageSize: 3 })));
    expect(parsed.conversations.map((c: { id: string }) => c.id)).toEqual(rows.map((r) => r.id));
    // 3 + 3 + 1: la última página corta termina sin otra consulta.
    expect(state.conversationFindMany).toHaveBeenCalledTimes(3);
    const second = state.conversationFindMany.mock.calls[1][0];
    expect(second.where.clientId).toBe('client_a');
    expect(second.orderBy).toEqual([{ startedAt: 'asc' }, { id: 'asc' }]);
    expect(second.where.OR[1]).toEqual({ startedAt: rows[2].startedAt, id: { gt: 'conv_2' } });
  });
});

describe('GET /api/portal/conversations/export (cliente)', () => {
  it('sin sesión de cliente, 401', async () => {
    state.getSession.mockResolvedValue({ hasClientAccess: false });
    expect((await clientGet(clientReq())).status).toBe(401);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('con la sesión de ejemplo (sin base de datos real), 401', async () => {
    state.resolveClientFromSession.mockResolvedValue({ clientId: 'demo', email: 'x', source: 'mock_dev' });
    expect((await clientGet(clientReq())).status).toBe(401);
  });

  it('un formato desconocido es 400, no un CSV que no pidió', async () => {
    const res = await clientGet(clientReq('?formato=xlsx'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_format' });
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('quien nunca tuvo chatbot ni conversaciones, 403', async () => {
    state.conversationCount.mockResolvedValue(0);
    state.clientProductFindFirst.mockResolvedValue(null);
    const res = await clientGet(clientReq());
    expect(res.status).toBe(403);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('el cliente sale SOLO de la sesión: un clientId en la URL no cambia nada', async () => {
    const res = await clientGet(clientReq('?formato=csv&clientId=client_b'));
    expect(res.status).toBe(200);
    await res.text();
    expect(state.conversationCount).toHaveBeenCalledWith({ where: { clientId: 'client_a' } });
    for (const call of state.conversationFindMany.mock.calls) expect(call[0].where.clientId).toBe('client_a');
    expect(state.auditCreate.mock.calls[0][0].data.clientId).toBe('client_a');
  });

  it('con el chatbot cancelado también exporta: busca el contrato en cualquier estado', async () => {
    const res = await clientGet(clientReq('?formato=json'));
    expect(res.status).toBe(200);
    const where = state.clientProductFindFirst.mock.calls[0][0].where;
    expect(where).toEqual({ clientId: 'client_a', product: { code: 'chatbot' } });
  });

  it('deja una fila de auditoría ANTES de mandar el fichero, solo con recuento y formato', async () => {
    state.conversationCount.mockResolvedValue(37);
    const res = await clientGet(clientReq('?formato=json'));
    expect(state.auditCreate).toHaveBeenCalledTimes(1);
    expect(state.conversationFindMany).not.toHaveBeenCalled(); // aún no se ha leído nada
    expect(state.auditCreate.mock.calls[0][0]).toEqual({
      data: {
        clientId: 'client_a',
        clientProductId: null,
        tenantId: '22222222-2222-4222-8222-222222222222',
        productCode: 'chatbot',
        action: 'exported',
        actor: 'client:client_a',
        metadata: { format: 'json', count: 37 },
      },
    });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="conversaciones-kairikos-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(JSON.parse(body).conversations).toHaveLength(1);
    // Nada del contenido exportado acaba en la auditoría.
    expect(JSON.stringify(state.auditCreate.mock.calls)).not.toContain('Ana');
  });

  it('sin formato, CSV con BOM', async () => {
    const res = await clientGet(clientReq());
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('sin el buzón contratado (una baja) pero con solicitudes guardadas, también se descargan', async () => {
    state.hasLeadsInboxAccess.mockResolvedValue(false);
    state.leadCount.mockResolvedValue(3);
    state.leadFindMany.mockResolvedValue([]);
    const res = await leadsGet(new NextRequest('http://localhost/api/portal/leads/export'));
    expect(res.status).toBe(200);
    expect(state.leadCount).toHaveBeenCalledWith({ where: { clientId: 'client_a' } });
  });

  it('sin buzón y sin solicitudes, 403', async () => {
    state.hasLeadsInboxAccess.mockResolvedValue(false);
    const res = await leadsGet(new NextRequest('http://localhost/api/portal/leads/export'));
    expect(res.status).toBe(403);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('si la auditoría falla, no hay fichero', async () => {
    state.auditCreate.mockRejectedValue(new Error('db down'));
    const res = await clientGet(clientReq());
    expect(res.status).toBe(500);
    expect(state.conversationFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/portal/conversations/export (operador)', () => {
  it('sin sesión de operador, 401', async () => {
    state.authenticateAdminRequest.mockResolvedValue({ ok: false });
    expect((await adminGet(adminReq('?clientId=client_a'))).status).toBe(401);
  });

  it('sin clientId o con un formato raro, 400', async () => {
    expect((await adminGet(adminReq())).status).toBe(400);
    expect((await adminGet(adminReq('?clientId=client_a&formato=pdf'))).status).toBe(400);
  });

  it('un cliente que no existe, 404', async () => {
    state.clientFindUnique.mockResolvedValue(null);
    expect((await adminGet(adminReq('?clientId=nadie'))).status).toBe(404);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('exporta el cliente pedido y lo audita con el operador como autor', async () => {
    const res = await adminGet(adminReq('?clientId=client_b&formato=csv'));
    expect(res.status).toBe(200);
    await res.text();
    expect(state.conversationFindMany.mock.calls[0][0].where.clientId).toBe('client_b');
    expect(state.auditCreate.mock.calls[0][0].data).toMatchObject({
      clientId: 'client_b',
      productCode: 'chatbot',
      action: 'exported',
      actor: 'operator:op_1',
      metadata: { format: 'csv', count: 1 },
    });
  });
});

describe('GET /api/portal/leads/export — ahora auditada', () => {
  it('deja una fila leads/exported con el recuento y sin datos de las solicitudes', async () => {
    state.leadFindMany.mockResolvedValue([
      { createdAt: T0, contactName: 'Ana Pérez', contactPhone: '+34600000000', contactEmail: 'ana@example.com', status: 'new' },
      { createdAt: T0, contactName: 'Luis', contactPhone: null, contactEmail: null, status: 'new' },
    ]);
    const res = await leadsGet(new NextRequest('http://localhost/api/portal/leads/export'));
    expect(res.status).toBe(200);
    expect(state.auditCreate).toHaveBeenCalledTimes(1);
    const data = state.auditCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      clientId: 'client_a',
      productCode: 'leads',
      action: 'exported',
      actor: 'client:client_a',
      metadata: { format: 'csv', count: 2 },
    });
    expect(JSON.stringify(data)).not.toMatch(/Ana|600000000|example\.com/);
  });

  it('si la auditoría falla, no hay fichero', async () => {
    state.leadFindMany.mockResolvedValue([]);
    state.auditCreate.mockRejectedValue(new Error('db down'));
    const res = await leadsGet(new NextRequest('http://localhost/api/portal/leads/export'));
    expect(res.status).toBe(500);
  });
});

describe('parseExportFormat', () => {
  it('csv por defecto, json si se pide, y null para lo demás', () => {
    expect(parseExportFormat(null)).toBe('csv');
    expect(parseExportFormat('')).toBe('csv');
    expect(parseExportFormat('JSON')).toBe('json');
    expect(parseExportFormat('xlsx')).toBeNull();
  });
});
