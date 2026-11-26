// =============================================================================
// La baja de los datos de un cliente (lib/client-data-exit.ts y
// POST /api/internal/client-data-exit), PR 5a del plan del encargo.
//
// Aquí, con Prisma mockeado: la entrada de la ruta (secreto, validación,
// códigos de respuesta), el correo de aviso, y que un fallo de Twilio no deje
// borrar nada en la base de datos. Los borrados de verdad, contra Postgres:
// tests/real/client-data-exit.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  loadExit: vi.fn(),
  notifyExit: vi.fn(),
  purgeExit: vi.fn(),
  deleteTwilioRecording: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: true, prisma: {} }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/twilio-credentials', () => ({ resolveActiveTwilioCredentials: async () => null }));
vi.mock('@/lib/recall-retention', () => ({ deleteTwilioRecording: (...a: unknown[]) => mocks.deleteTwilioRecording(...a) }));

import { purgeExit, renderExitNoticeEmail } from '@/lib/client-data-exit';

const NOW = new Date('2027-03-01T10:00:00.000Z');
const DAY = 86_400_000;

describe('renderExitNoticeEmail', () => {
  it('dice qué se borra, cuándo y dónde descargarlo, con enlace al portal', () => {
    const email = renderExitNoticeEmail({
      clientName: 'Clínica <Sol>',
      product: 'recall',
      graceEndsAt: new Date('2027-03-31T10:00:00.000Z'),
      counts: { calls: 3, outboundMessages: 0 },
    });
    expect(email.subject).toBe('Tus datos de la recuperación de llamadas se borran el 31 de marzo: descárgalos antes');
    expect(email.text).toContain('hasta el 31 de marzo de 2027');
    expect(email.text).toContain('/portal/llamadas');
    expect(email.html).toContain('Clínica &lt;Sol&gt;');
    expect(email.html).toMatch(/<a href="https:\/\/[^"]+\/portal\/llamadas">/);
  });
});

describe('purgeExit — llamadas', () => {
  const cancelled = { status: 'cancelled', cancelledAt: new Date(NOW.getTime() - 40 * DAY), changedAt: new Date(NOW.getTime() - 40 * DAY), product: { code: 'recall' }, id: 'cp1' };
  const db = {
    chatbotClient: { findUnique: vi.fn(async () => ({ id: 'cli', email: 'c@example.test', name: 'C', companyName: null, tenantId: null })) },
    clientProduct: { findMany: vi.fn(async () => [cancelled]) },
    clientDataAudit: { findFirst: vi.fn(async () => ({ createdAt: new Date(NOW.getTime() - 10 * DAY) })) },
    recallSubscription: { findMany: vi.fn(async () => [{ id: 'sub1' }]) },
    outboundMessage: { count: vi.fn(async () => 0) },
    callEvent: {
      count: vi.fn(async (args: { where: Record<string, unknown> }) => ('recordingSid' in args.where ? 2 : 5)),
      findMany: vi.fn(async () => [
        { id: 'c1', recordingSid: 'RE1' },
        { id: 'c2', recordingSid: 'RE2' },
      ]),
      update: vi.fn(async () => ({})),
    },
    virtualNumber: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(),
  };
  const prisma = db as unknown as PrismaClient;
  const auth = async () => ({ accountSid: 'AC', authToken: 't' });

  beforeEach(() => {
    db.$transaction.mockReset();
    db.callEvent.update.mockClear();
    mocks.deleteTwilioRecording.mockReset();
  });

  it('si Twilio falla en una grabación, para ahí y no borra nada en la base de datos', async () => {
    mocks.deleteTwilioRecording.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'twilio_500' });
    const r = await purgeExit(prisma, 'cli', 'recall', 'operator:ops@example.test', true, NOW, { twilioAuth: auth });
    expect(r).toMatchObject({ ok: false, error: 'twilio_failed', detail: 'RE2: twilio_500' });
    // La primera sí se marcó como borrada (ya no está en Twilio); la segunda no.
    expect(db.callEvent.update).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('sin credenciales de Twilio y con grabaciones pendientes, no empieza', async () => {
    const r = await purgeExit(prisma, 'cli', 'recall', 'operator:ops@example.test', true, NOW, { twilioAuth: async () => null });
    expect(r).toMatchObject({ ok: false, error: 'twilio_not_configured' });
    expect(mocks.deleteTwilioRecording).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('sin confirmar es el modo de prueba: no llama a Twilio ni escribe', async () => {
    const r = await purgeExit(prisma, 'cli', 'recall', 'operator:ops@example.test', false, NOW, { twilioAuth: auth });
    expect(r).toMatchObject({ ok: true, done: 'dry_run' });
    expect(r.status.counts).toMatchObject({ calls: 5, recordings: 2 });
    expect(mocks.deleteTwilioRecording).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/client-data-exit', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test_cron_secret';
    vi.resetModules();
    vi.doMock('@/lib/client-data-exit', async (orig) => ({
      ...(await orig<typeof import('@/lib/client-data-exit')>()),
      loadExit: (...a: unknown[]) => mocks.loadExit(...a),
      notifyExit: (...a: unknown[]) => mocks.notifyExit(...a),
      purgeExit: (...a: unknown[]) => mocks.purgeExit(...a),
    }));
    mocks.loadExit.mockReset().mockResolvedValue({ client: { id: 'cli' }, status: { blockers: [] } });
    mocks.notifyExit.mockReset();
    mocks.purgeExit.mockReset().mockResolvedValue({ ok: true, done: 'dry_run', status: {} });
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    vi.doUnmock('@/lib/client-data-exit');
  });

  const call = async (body: unknown, auth = 'Bearer test_cron_secret') => {
    const { POST } = await import('@/app/api/internal/client-data-exit/route');
    return POST(
      new NextRequest('http://localhost/api/internal/client-data-exit', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  };

  it('401 sin el secreto, sin tocar nada', async () => {
    const res = await call({ clientId: 'cli', product: 'chatbot', action: 'estado' }, 'Bearer otro');
    expect(res.status).toBe(401);
    expect(mocks.loadExit).not.toHaveBeenCalled();
  });

  it.each([
    [{ clientId: 'a b', product: 'chatbot', action: 'estado' }],
    [{ clientId: 'cli', product: 'reviews', action: 'estado' }],
    [{ clientId: 'cli', product: 'chatbot', action: 'purge' }],
    [{ clientId: 'cli', product: 'chatbot', action: 'borrar' }],
    [{ clientId: 'cli', product: 'chatbot', action: 'avisar', operator: 'x y' }],
  ])('400 con una entrada mala: %j', async (body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
  });

  it('estado no pide operador', async () => {
    const res = await call({ clientId: 'cli', product: 'leads', action: 'estado' });
    expect(res.status).toBe(200);
    expect(mocks.loadExit).toHaveBeenCalledWith({}, 'cli', 'leads', expect.any(Date));
  });

  it('borrar sin confirm: true llega como modo de prueba', async () => {
    await call({ clientId: 'cli', product: 'chatbot', action: 'borrar', operator: 'ops@example.test', confirm: 'true' });
    expect(mocks.purgeExit.mock.calls[0][4]).toBe(false);
    await call({ clientId: 'cli', product: 'chatbot', action: 'borrar', operator: 'ops@example.test', confirm: true });
    expect(mocks.purgeExit.mock.calls[1][4]).toBe(true);
  });

  it('un bloqueo responde 409; un fallo de correo o de Twilio, 502', async () => {
    mocks.purgeExit.mockResolvedValueOnce({ ok: false, error: 'grace_not_over', status: {} });
    expect((await call({ clientId: 'cli', product: 'chatbot', action: 'borrar', operator: 'ops', confirm: true })).status).toBe(409);
    mocks.notifyExit.mockResolvedValueOnce({ ok: false, error: 'email_failed', status: {} });
    expect((await call({ clientId: 'cli', product: 'chatbot', action: 'avisar', operator: 'ops' })).status).toBe(502);
  });
});
