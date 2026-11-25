// =============================================================================
// RGPD (25/11/2026, PR 2 del plan del encargo) — exportación de los registros
// de llamadas (CallEvent).
//
// Lo que no puede pasar: que la URL de la grabación salga en el fichero, que
// un número oculto aparezca, que una transcripción se ejecute como fórmula en
// Excel, que un cliente se lleve la línea de otro, o que haya fichero sin su
// fila de auditoría (o una auditoría con datos personales).
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  authenticateAdminRequest: vi.fn(),
  subFindMany: vi.fn(),
  subFindUnique: vi.fn(),
  callCount: vi.fn(),
  callFindMany: vi.fn(),
  auditCreate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    recallSubscription: {
      findMany: (...a: unknown[]) => state.subFindMany(...a),
      findUnique: (...a: unknown[]) => state.subFindUnique(...a),
    },
    callEvent: {
      count: (...a: unknown[]) => state.callCount(...a),
      findMany: (...a: unknown[]) => state.callFindMany(...a),
    },
    clientDataAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
    operator: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => state.getSession(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => state.resolveClientFromSession(...a),
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => state.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => state.logError(...a) }));

import { recallExportChunks, recordingState, type RecallExportCall } from '@/lib/recall-export';
import { GET as clientGet } from '@/app/api/portal/recall/calls/export/route';
import { GET as adminGet } from '@/app/api/admin/portal/recall/[subscriptionId]/export/route';

const SUB = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-11-20T10:00:00.000Z');

function call(over: Partial<RecallExportCall> = {}): RecallExportCall {
  return {
    id: 'call_1',
    startedAt: T0,
    endedAt: new Date('2026-11-20T10:01:00.000Z'),
    fromNumber: '+34600111222',
    withheld: false,
    toNumber: '+34910000000',
    outcome: 'recorded',
    recordingSid: 'RE123',
    recordingDurationSeconds: 25,
    recordingDeletedAt: null,
    transcript: 'Hola, soy Ana, llámame a partir de las cinco',
    callerNotifyChannel: 'whatsapp',
    legalNoticeVersion: '2026-09-v1',
    legalNoticeSentAt: new Date('2026-11-20T10:01:30.000Z'),
    callerLanguage: 'es',
    callbackSlotAt: new Date('2026-11-20T17:00:00.000Z'),
    ...over,
  };
}

async function readAll(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let out = '';
  for await (const chunk of gen) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

function pagedFindMany(rows: RecallExportCall[]) {
  return async (args: { where: Record<string, unknown>; take: number; select: Record<string, unknown> }) => {
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

const prismaLike = () => ({ callEvent: { findMany: (...a: unknown[]) => state.callFindMany(...a) } }) as never;

const clientReq = (query = '') => new NextRequest(`http://localhost/api/portal/recall/calls/export${query}`);
const adminReq = (sub: string, query = '') =>
  adminGet(new NextRequest(`http://localhost/api/admin/portal/recall/${sub}/export${query}`), {
    params: Promise.resolve({ subscriptionId: sub }),
  });

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.getSession.mockResolvedValue({ hasClientAccess: true });
  state.resolveClientFromSession.mockResolvedValue({ clientId: 'client_a', email: 'a@example.com', source: 'database' });
  state.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  state.subFindMany.mockResolvedValue([{ id: SUB }]);
  state.subFindUnique.mockResolvedValue({
    id: SUB,
    clientId: 'client_a',
    clientProductId: LINE,
    tenantId: '22222222-2222-4222-8222-222222222222',
    virtualNumber: { e164: '+34910000000' },
  });
  state.callCount.mockResolvedValue(1);
  state.callFindMany.mockImplementation(pagedFindMany([call()]));
  state.auditCreate.mockResolvedValue({});
});

describe('recordingState', () => {
  it('disponible, borrada o sin grabación — nunca la URL', () => {
    expect(recordingState({ recordingSid: 'RE1', recordingDeletedAt: null })).toBe('available');
    expect(recordingState({ recordingSid: 'RE1', recordingDeletedAt: T0 })).toBe('deleted');
    expect(recordingState({ recordingSid: null, recordingDeletedAt: null })).toBe('none');
  });
});

describe('CSV', () => {
  it('BOM, cabecera en castellano, etiquetas legibles y la grabación como estado', async () => {
    const csv = await readAll(recallExportChunks(prismaLike(), SUB, 'csv'));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Fecha,Fin,Número de quien llamó,Número marcado,Resultado,Duración del recado (s),Transcripción,Grabación,Aviso a quien llamó,Versión del aviso legal,Aviso legal enviado,Idioma,Devolución agendada',
    );
    // El teléfono empieza por «+»: sin el apóstrofo Excel lo tomaría por una fórmula.
    expect(lines[1]).toBe(
      "2026-11-20T10:00:00.000Z,2026-11-20T10:01:00.000Z,'+34600111222,'+34910000000,Dejó un recado,25,\"Hola, soy Ana, llámame a partir de las cinco\",disponible,WhatsApp,2026-09-v1,2026-11-20T10:01:30.000Z,Español,2026-11-20T17:00:00.000Z",
    );
  });

  it('número oculto, grabación borrada con su fecha y transcripción con fórmula neutralizada', async () => {
    state.callFindMany.mockImplementation(
      pagedFindMany([
        call({
          fromNumber: null,
          withheld: true,
          outcome: 'withheld',
          recordingDeletedAt: new Date('2026-11-21T03:00:00.000Z'),
          transcript: '=cmd|"/C calc"!A0',
          callerNotifyChannel: 'unreachable',
          callerLanguage: null,
          callbackSlotAt: null,
        }),
      ]),
    );
    const line = (await readAll(recallExportChunks(prismaLike(), SUB, 'csv'))).slice(1).split('\r\n')[1];
    expect(line).toContain(',Oculto,');
    expect(line).toContain('Número oculto');
    expect(line).toContain('borrada el 2026-11-21');
    expect(line).toContain(`"'=cmd|""/C calc""!A0"`);
    expect(line).toContain('No: no pudimos escribirle');
  });

  it('un número guardado pero marcado como oculto tampoco sale', async () => {
    state.callFindMany.mockImplementation(pagedFindMany([call({ withheld: true })]));
    const csv = await readAll(recallExportChunks(prismaLike(), SUB, 'csv'));
    expect(csv).not.toContain('600111222');
  });

  it('nunca pide la URL de la grabación a la base de datos', async () => {
    await readAll(recallExportChunks(prismaLike(), SUB, 'csv'));
    expect(state.callFindMany.mock.calls[0][0].select).not.toHaveProperty('recordingUrl');
  });
});

describe('JSON', () => {
  it('un objeto por llamada y JSON válido, sin URL de grabación', async () => {
    state.callFindMany.mockImplementation(
      pagedFindMany([call(), call({ id: 'call_2', startedAt: new Date('2026-11-21T09:00:00.000Z'), recordingSid: null, recordingDurationSeconds: null, outcome: 'no_message' })]),
    );
    const now = new Date('2026-11-25T08:00:00.000Z');
    const text = await readAll(recallExportChunks(prismaLike(), SUB, 'json', { now, line: '+34910000000' }));
    const parsed = JSON.parse(text);
    expect(parsed.product).toBe('recall');
    expect(parsed.line).toBe('+34910000000');
    expect(parsed.calls).toHaveLength(2);
    expect(parsed.calls[0]).toEqual({
      id: 'call_1',
      startedAt: '2026-11-20T10:00:00.000Z',
      endedAt: '2026-11-20T10:01:00.000Z',
      from: '+34600111222',
      withheld: false,
      to: '+34910000000',
      outcome: 'recorded',
      messageSeconds: 25,
      transcript: 'Hola, soy Ana, llámame a partir de las cinco',
      recording: { state: 'available', deletedAt: null },
      callerNotifyChannel: 'whatsapp',
      legalNoticeVersion: '2026-09-v1',
      legalNoticeSentAt: '2026-11-20T10:01:30.000Z',
      callerLanguage: 'es',
      callbackSlotAt: '2026-11-20T17:00:00.000Z',
    });
    expect(parsed.calls[1].recording).toEqual({ state: 'none', deletedAt: null });
    expect(text).not.toMatch(/recordingUrl|api\.twilio\.com/);
  });

  it('sin llamadas también es JSON válido', async () => {
    state.callFindMany.mockResolvedValue([]);
    expect(JSON.parse(await readAll(recallExportChunks(prismaLike(), SUB, 'json'))).calls).toEqual([]);
  });

  it('recorre todas las páginas por cursor', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => call({ id: `call_${i}`, startedAt: new Date(T0.getTime() + Math.floor(i / 2) * 1000) }));
    state.callFindMany.mockImplementation(pagedFindMany(rows));
    const parsed = JSON.parse(await readAll(recallExportChunks(prismaLike(), SUB, 'json', { pageSize: 2 })));
    expect(parsed.calls.map((c: { id: string }) => c.id)).toEqual(rows.map((r) => r.id));
    for (const c of state.callFindMany.mock.calls) expect(c[0].where.subscriptionId).toBe(SUB);
  });
});

describe('GET /api/portal/recall/calls/export (cliente)', () => {
  it('sin sesión de cliente, 401', async () => {
    state.getSession.mockResolvedValue({ hasClientAccess: false });
    expect((await clientGet(clientReq())).status).toBe(401);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('un formato desconocido o una línea que no es un uuid, 400', async () => {
    expect((await clientGet(clientReq('?formato=xml'))).status).toBe(400);
    expect((await clientGet(clientReq(`?clientProductId=no-es-uuid`))).status).toBe(400);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('sin servicio contratado, 404; con varias líneas y sin elegir, 409', async () => {
    state.subFindMany.mockResolvedValue([]);
    expect((await clientGet(clientReq())).status).toBe(404);
    state.subFindMany.mockResolvedValue([{ id: SUB }, { id: 'otra' }]);
    expect((await clientGet(clientReq())).status).toBe(409);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('el cliente sale de la sesión y el id de línea solo filtra SUS suscripciones', async () => {
    const res = await clientGet(clientReq(`?formato=csv&clientProductId=${LINE}&clientId=client_b`));
    expect(res.status).toBe(200);
    await res.text();
    expect(state.subFindMany.mock.calls[0][0].where).toEqual({ clientId: 'client_a', clientProductId: LINE });
    expect(state.auditCreate.mock.calls[0][0].data.clientId).toBe('client_a');
  });

  it('una suscripción de otro cliente (segunda cerradura), 404 y sin auditoría', async () => {
    state.subFindUnique.mockResolvedValue({ id: SUB, clientId: 'client_b', clientProductId: LINE, tenantId: null, virtualNumber: null });
    expect((await clientGet(clientReq())).status).toBe(404);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('audita ANTES de mandar, con la línea, el recuento y el formato — nada más', async () => {
    state.callCount.mockResolvedValue(12);
    const res = await clientGet(clientReq('?formato=json'));
    expect(state.callFindMany).not.toHaveBeenCalled();
    expect(state.auditCreate.mock.calls[0][0]).toEqual({
      data: {
        clientId: 'client_a',
        clientProductId: LINE,
        tenantId: '22222222-2222-4222-8222-222222222222',
        productCode: 'recall',
        action: 'exported',
        actor: 'client:client_a',
        metadata: { format: 'json', count: 12 },
      },
    });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="llamadas-kairikos-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(JSON.parse(await res.text()).calls).toHaveLength(1);
    expect(JSON.stringify(state.auditCreate.mock.calls)).not.toMatch(/600111222|Ana/);
  });

  it('si la auditoría falla, no hay fichero', async () => {
    state.auditCreate.mockRejectedValue(new Error('db down'));
    const res = await clientGet(clientReq());
    expect(res.status).toBe(500);
    expect(state.callFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/portal/recall/[subscriptionId]/export (operador)', () => {
  it('sin sesión de operador, 401', async () => {
    state.authenticateAdminRequest.mockResolvedValue({ ok: false });
    expect((await adminReq(SUB)).status).toBe(401);
  });

  it('un id que no es uuid o una suscripción que no existe, 404; un formato raro, 400', async () => {
    expect((await adminReq('nada')).status).toBe(404);
    state.subFindUnique.mockResolvedValue(null);
    expect((await adminReq(SUB, '?formato=csv')).status).toBe(404);
    state.subFindUnique.mockResolvedValue({ id: SUB, clientId: 'client_a', clientProductId: LINE, tenantId: null, virtualNumber: null });
    expect((await adminReq(SUB, '?formato=pdf')).status).toBe(400);
    expect(state.auditCreate).not.toHaveBeenCalled();
  });

  it('exporta esa línea y lo audita con el operador como autor', async () => {
    const res = await adminReq(SUB, '?formato=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    await res.text();
    expect(state.callFindMany.mock.calls[0][0].where.subscriptionId).toBe(SUB);
    expect(state.auditCreate.mock.calls[0][0].data).toMatchObject({
      clientId: 'client_a',
      clientProductId: LINE,
      productCode: 'recall',
      action: 'exported',
      actor: 'operator:op_1',
      metadata: { format: 'csv', count: 1 },
    });
  });
});
