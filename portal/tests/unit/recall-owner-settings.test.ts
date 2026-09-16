// =============================================================================
// WhatsApp del dueño y locución de recall — lib/wav-audio.ts,
// lib/recall-owner-settings.ts y sus rutas de cliente y operador.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  subFindFirst: vi.fn(),
  subUpdate: vi.fn(),
  auditCreate: vi.fn(),
  operatorFindUnique: vi.fn(),
  sendForwardingInstructions: vi.fn(),
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  authenticateAdminRequest: vi.fn(),
  logError: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  recallSubscription: {
    findUnique: (...a: unknown[]) => mockState.subFindUnique(...a),
    findFirst: (...a: unknown[]) => mockState.subFindFirst(...a),
    update: (...a: unknown[]) => mockState.subUpdate(...a),
  },
  recallSubscriptionAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
  operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
}));

vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: true, prisma: prismaMock }));
vi.mock('@/lib/recall-templates', () => ({
  sendForwardingInstructions: (...a: unknown[]) => mockState.sendForwardingInstructions(...a),
}));
vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockState.getSession(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import { downsample, encodeWav, sniffAudio, GREETING_SAMPLE_RATE } from '@/lib/wav-audio';
import {
  validateOwnerWhatsapp,
  validateGreeting,
  setOwnerWhatsapp,
  setGreeting,
  clearGreeting,
  readGreeting,
  MAX_GREETING_BYTES,
} from '@/lib/recall-owner-settings';
import * as clientOwnerRoute from '@/app/api/portal/recall/owner/route';
import * as clientGreetingRoute from '@/app/api/portal/recall/greeting/route';
import * as operatorOwnerRoute from '@/app/api/admin/portal/recall/[subscriptionId]/owner/route';
import * as operatorGreetingRoute from '@/app/api/admin/portal/recall/[subscriptionId]/greeting/route';

const prisma = prismaMock as unknown as PrismaClient;
const SUB_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT = { type: 'client' as const, clientId: 'client_1' };

function wavOfSeconds(seconds: number): Uint8Array {
  return encodeWav(new Float32Array(Math.round(seconds * GREETING_SAMPLE_RATE)), GREETING_SAMPLE_RATE);
}

const SUB = {
  id: SUB_ID,
  clientId: 'client_1',
  status: 'forwarding_pending',
  ownerWhatsapp: null as string | null,
  greetingAudio: null as Buffer | null,
  greetingMimeType: null as string | null,
  virtualNumber: { e164: '+34910123456' },
  metaConnection: {
    id: 'conn_1',
    externalId: 'phone_1',
    status: 'active',
    displayPhoneNumber: '+34 611 22 33 44',
    accessTokenCiphertext: Buffer.from('c'),
    accessTokenIv: Buffer.from('i'),
    accessTokenTag: Buffer.from('t'),
  },
};

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

function bytesReq(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.subFindUnique.mockResolvedValue(SUB);
  mockState.subFindFirst.mockResolvedValue({ id: SUB_ID });
  mockState.subUpdate.mockResolvedValue({});
  mockState.auditCreate.mockResolvedValue({});
  mockState.operatorFindUnique.mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.sendForwardingInstructions.mockResolvedValue('sent');
  mockState.getSession.mockResolvedValue({ hasClientAccess: true });
  mockState.resolveClientFromSession.mockResolvedValue({ clientId: 'client_1', source: 'database' });
  mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
});

// -----------------------------------------------------------------------------
describe('wav-audio', () => {
  it('lo que codifica el grabador se reconoce como WAV con su duración real', () => {
    const sniffed = sniffAudio(wavOfSeconds(12));
    expect(sniffed).toEqual({ ok: true, mimeType: 'audio/wav', durationSeconds: 12 });
  });

  it('30 segundos a 16 kHz caben en el tope de 1 MB', () => {
    expect(wavOfSeconds(30).length).toBeLessThan(MAX_GREETING_BYTES);
  });

  it('recorta las muestras fuera de rango en vez de desbordar', () => {
    const wav = encodeWav(new Float32Array([2, -2]), 8000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it('downsample reduce la longitud en la proporción justa', () => {
    expect(downsample(new Float32Array(48_000), 48_000, 16_000)).toHaveLength(16_000);
    const same = new Float32Array(10);
    expect(downsample(same, 16_000, 16_000)).toBe(same);
  });

  it('encuentra los datos aunque haya otros bloques antes (LIST)', () => {
    const plain = wavOfSeconds(3);
    const list = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 0x49, 0x4e, 0x46, 0x4f]));
    const withList = new Uint8Array(plain.length + list.length);
    withList.set(plain.subarray(0, 36), 0);
    withList.set(list, 36);
    withList.set(plain.subarray(36), 36 + list.length);
    expect(sniffAudio(withList)).toEqual({ ok: true, mimeType: 'audio/wav', durationSeconds: 3 });
  });

  it('reconoce MP3 por ID3 o por sincronía de trama, y nada más', () => {
    expect(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 3, 0]))).toMatchObject({ ok: true, mimeType: 'audio/mpeg' });
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toMatchObject({ ok: true, mimeType: 'audio/mpeg' });
    // WebM (lo que graba Chrome): Twilio no lo reproduce.
    expect(sniffAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ ok: false, error: 'unsupported_format' });
    // "RIFF…WAVE" sin bloque de datos.
    const broken = wavOfSeconds(3).subarray(0, 30);
    expect(sniffAudio(broken)).toEqual({ ok: false, error: 'corrupt_wav' });
  });
});

// -----------------------------------------------------------------------------
describe('validateOwnerWhatsapp', () => {
  it('normaliza un móvil español sin prefijo', () => {
    expect(validateOwnerWhatsapp('600 11 22 33', null)).toEqual({ ok: true, e164: '+34600112233' });
  });

  it('rechaza un fijo: a un fijo no llegan los recados', () => {
    expect(validateOwnerWhatsapp('910 12 34 56', null)).toEqual({ ok: false, error: 'not_mobile' });
  });

  it('rechaza el propio número del negocio, escrito como sea', () => {
    expect(validateOwnerWhatsapp('611223344', '+34 611 22 33 44')).toEqual({ ok: false, error: 'same_as_business' });
  });

  it('rechaza lo que no es un número', () => {
    expect(validateOwnerWhatsapp('hola', null)).toEqual({ ok: false, error: 'invalid_number' });
    expect(validateOwnerWhatsapp('12345678901', null)).toEqual({ ok: false, error: 'invalid_number' });
  });

  it('acepta un móvil extranjero con prefijo', () => {
    expect(validateOwnerWhatsapp('+44 7700 900123', null)).toEqual({ ok: true, e164: '+447700900123' });
  });
});

describe('validateGreeting', () => {
  it.each([
    [new Uint8Array(), 'empty'],
    [wavOfSeconds(1), 'too_short'],
    [wavOfSeconds(31), 'too_long'],
    [new Uint8Array(MAX_GREETING_BYTES + 1), 'too_large'],
    [new Uint8Array([1, 2, 3, 4]), 'unsupported_format'],
  ])('rechaza %#: %s', (bytes, error) => {
    expect(validateGreeting(bytes)).toEqual({ ok: false, error });
  });

  it('acepta un WAV de 10 s y un MP3 (sin duración calculable)', () => {
    expect(validateGreeting(wavOfSeconds(10))).toEqual({ ok: true, mimeType: 'audio/wav', durationSeconds: 10 });
    expect(validateGreeting(new Uint8Array([0x49, 0x44, 0x33, 3, 0]))).toEqual({
      ok: true,
      mimeType: 'audio/mpeg',
      durationSeconds: null,
    });
  });
});

// -----------------------------------------------------------------------------
describe('setOwnerWhatsapp', () => {
  it('guarda, audita enmascarado y, con el alta esperando el desvío, manda los códigos', async () => {
    const result = await setOwnerWhatsapp(prisma, { subscriptionId: SUB_ID, raw: '600112233', actor: CLIENT });

    expect(result).toEqual({ ok: true, ownerWhatsapp: '+34600112233', forwardingInstructions: 'sent' });
    expect(mockState.subUpdate).toHaveBeenCalledWith({ where: { id: SUB_ID }, data: { ownerWhatsapp: '+34600112233' } });
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'owner_whatsapp_changed',
        before: { ownerWhatsapp: null },
        after: { ownerWhatsapp: '…2233' },
        actorType: 'client',
        actorEmail: 'client:client_1',
      }),
    });
    expect(mockState.sendForwardingInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUB_ID, ownerWhatsapp: '+34600112233', virtualNumber: { e164: '+34910123456' } }),
    );
  });

  it('con el servicio ya activo no reenvía los códigos de desvío', async () => {
    mockState.subFindUnique.mockResolvedValue({ ...SUB, status: 'active' });
    const result = await setOwnerWhatsapp(prisma, { subscriptionId: SUB_ID, raw: '600112233', actor: CLIENT });
    expect(result).toMatchObject({ ok: true, forwardingInstructions: null });
    expect(mockState.sendForwardingInstructions).not.toHaveBeenCalled();
  });

  it('guardar el mismo número otra vez no reenvía los códigos', async () => {
    mockState.subFindUnique.mockResolvedValue({ ...SUB, ownerWhatsapp: '+34600112233' });
    await setOwnerWhatsapp(prisma, { subscriptionId: SUB_ID, raw: '+34 600 11 22 33', actor: CLIENT });
    expect(mockState.sendForwardingInstructions).not.toHaveBeenCalled();
  });

  it('un cliente no puede tocar la suscripción de otro', async () => {
    const result = await setOwnerWhatsapp(prisma, {
      subscriptionId: SUB_ID,
      raw: '600112233',
      actor: { type: 'client', clientId: 'otro' },
    });
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });

  it('no guarda un número inválido', async () => {
    const result = await setOwnerWhatsapp(prisma, { subscriptionId: SUB_ID, raw: '611 22 33 44', actor: CLIENT });
    expect(result).toEqual({ ok: false, error: 'same_as_business' });
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });

  it('el operador queda atribuido en la auditoría', async () => {
    await setOwnerWhatsapp(prisma, {
      subscriptionId: SUB_ID,
      raw: '600112233',
      actor: { type: 'operator', operatorId: 'op_1', email: 'op@kairikos.com' },
    });
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: 'operator', actorOperatorId: 'op_1', actorEmail: 'op@kairikos.com' }),
    });
  });
});

describe('setGreeting / clearGreeting / readGreeting', () => {
  it('guarda el audio con su tipo y audita solo metadatos', async () => {
    const now = new Date('2026-09-16T15:00:00Z');
    const wav = wavOfSeconds(8);
    const result = await setGreeting(prisma, { subscriptionId: SUB_ID, bytes: wav, actor: CLIENT, now });

    expect(result).toEqual({ ok: true, mimeType: 'audio/wav', durationSeconds: 8, sizeBytes: wav.length });
    const update = mockState.subUpdate.mock.calls[0][0];
    expect(update.data.greetingMimeType).toBe('audio/wav');
    expect(update.data.greetingRecordedAt).toEqual(now);
    expect(Buffer.isBuffer(update.data.greetingAudio)).toBe(true);
    const audit = mockState.auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('greeting_recorded');
    expect(JSON.stringify(audit.after)).not.toMatch(/RIFF/);
    expect(audit.after).toEqual({ mimeType: 'audio/wav', sizeBytes: wav.length, durationSeconds: 8 });
  });

  it('no toca la base si el audio no vale', async () => {
    const result = await setGreeting(prisma, { subscriptionId: SUB_ID, bytes: wavOfSeconds(31), actor: CLIENT });
    expect(result).toEqual({ ok: false, error: 'too_long' });
    expect(mockState.subFindUnique).not.toHaveBeenCalled();
  });

  it('aísla por cliente al guardar, leer y borrar', async () => {
    const other = { type: 'client' as const, clientId: 'otro' };
    mockState.subFindUnique.mockResolvedValue({ ...SUB, greetingAudio: Buffer.from(wavOfSeconds(3)) });
    await expect(setGreeting(prisma, { subscriptionId: SUB_ID, bytes: wavOfSeconds(3), actor: other })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
    await expect(readGreeting(prisma, { subscriptionId: SUB_ID, actor: other })).resolves.toBeNull();
    await expect(clearGreeting(prisma, { subscriptionId: SUB_ID, actor: other })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });

  it('borrar deja las tres columnas a null y lo audita; sin locución no hace nada', async () => {
    mockState.subFindUnique.mockResolvedValueOnce({ ...SUB, greetingAudio: Buffer.from('x') });
    await expect(clearGreeting(prisma, { subscriptionId: SUB_ID, actor: CLIENT })).resolves.toEqual({ ok: true });
    expect(mockState.subUpdate).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { greetingAudio: null, greetingMimeType: null, greetingRecordedAt: null },
    });
    expect(mockState.auditCreate.mock.calls[0][0].data.action).toBe('greeting_removed');

    mockState.subUpdate.mockClear();
    await expect(clearGreeting(prisma, { subscriptionId: SUB_ID, actor: CLIENT })).resolves.toEqual({ ok: true });
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe('rutas del cliente', () => {
  it('401 sin sesión de cliente', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    expect((await clientOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '600112233' }))).status).toBe(401);
    expect((await clientGreetingRoute.GET()).status).toBe(401);
  });

  it('la suscripción sale de la sesión, nunca del cuerpo', async () => {
    const res = await clientOwnerRoute.PATCH(
      jsonReq({ ownerWhatsapp: '600112233', subscriptionId: 'otra', clientId: 'otro' }),
    );
    expect(res.status).toBe(200);
    expect(mockState.subFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'client_1' } }));
    expect(mockState.subFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SUB_ID } }));
  });

  it('404 si el cliente no tiene recall', async () => {
    mockState.subFindFirst.mockResolvedValue(null);
    expect((await clientOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '600112233' }))).status).toBe(404);
  });

  it('traduce la validación a 400 con el código', async () => {
    const res = await clientOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '910123456' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_mobile' });
  });

  it('PUT corta por la cabecera antes de leer un cuerpo demasiado grande', async () => {
    const req = bytesReq(new Uint8Array(1), { 'content-length': String(MAX_GREETING_BYTES + 1) });
    const res = await clientGreetingRoute.PUT(req);
    expect(res.status).toBe(413);
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });

  it('PUT con WebM responde 415', async () => {
    const res = await clientGreetingRoute.PUT(bytesReq(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])));
    expect(res.status).toBe(415);
  });

  it('PUT guarda un WAV válido', async () => {
    const res = await clientGreetingRoute.PUT(bytesReq(wavOfSeconds(5), { 'content-type': 'audio/wav' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mimeType: 'audio/wav', durationSeconds: 5 });
  });

  it('GET devuelve el audio sin caché; 404 si no hay', async () => {
    mockState.subFindUnique.mockResolvedValueOnce({ ...SUB, greetingAudio: Buffer.from(wavOfSeconds(3)), greetingMimeType: 'audio/wav' });
    const res = await clientGreetingRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    expect((await clientGreetingRoute.GET()).status).toBe(404);
  });
});

describe('rutas del operador', () => {
  const ctx = { params: { subscriptionId: SUB_ID } };

  it('401 sin sesión y 403 con la clave de API heredada', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    expect((await operatorOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '600112233' }), ctx)).status).toBe(401);
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: true, sessionId: null, operatorId: 'legacy' });
    expect((await operatorOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '600112233' }), ctx)).status).toBe(403);
    expect(mockState.subUpdate).not.toHaveBeenCalled();
  });

  it('rechaza un id con forma rara sin consultar', async () => {
    const res = await operatorGreetingRoute.GET(jsonReq(null), { params: { subscriptionId: '../x' } });
    expect(res.status).toBe(404);
    expect(mockState.subFindUnique).not.toHaveBeenCalled();
  });

  it('guarda el WhatsApp atribuido al operador', async () => {
    const res = await operatorOwnerRoute.PATCH(jsonReq({ ownerWhatsapp: '600112233' }), ctx);
    expect(res.status).toBe(200);
    expect(mockState.auditCreate.mock.calls[0][0].data).toMatchObject({ actorType: 'operator', actorEmail: 'op@kairikos.com' });
  });

  it('sube y borra la locución', async () => {
    expect((await operatorGreetingRoute.PUT(bytesReq(wavOfSeconds(4)), ctx)).status).toBe(200);
    mockState.subFindUnique.mockResolvedValueOnce({ ...SUB, greetingAudio: Buffer.from('x') });
    expect((await operatorGreetingRoute.DELETE(jsonReq(null), ctx)).status).toBe(200);
  });
});
