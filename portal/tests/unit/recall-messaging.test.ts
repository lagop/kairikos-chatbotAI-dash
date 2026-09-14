// =============================================================================
// WP-XX (Fase 9) — unit tests for the messaging engine.
//
// This is the module that talks to strangers from a client's own WhatsApp
// number, so the tests are organised around what it must never do: message
// too early, message someone twice, message a blocked robot, promise a
// callback time the business cannot keep, or retry forever a send that
// will never work.
//
// The telephony fake is injected rather than mocked, so the SMS fallback
// is exercised through the real provider contract and the test can assert
// on the BODY — the wording is a promise the business has to keep, and a
// test that only counted sends would pass on an engine that told everyone
// the wrong thing.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createFakeTelephonyProvider } from '@/lib/telephony/fake';

const mockState = vi.hoisted(() => ({
  decryptMetaToken: vi.fn(),
  sendTemplate: vi.fn(),
  isNumberBlocked: vi.fn(),
}));

vi.mock('@/lib/meta-business', () => ({
  decryptMetaToken: (...a: unknown[]) => mockState.decryptMetaToken(...a),
}));
vi.mock('@/lib/whatsapp-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-api')>('@/lib/whatsapp-api');
  return { ...actual, sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a) };
});
vi.mock('@/lib/recall-blocklist', () => ({
  isNumberBlocked: (...a: unknown[]) => mockState.isNumberBlocked(...a),
}));

import {
  notifyCaller,
  notifyOwner,
  sweepPendingNotifications,
  looksLikeWhatsAppCapable,
  RECALL_TEMPLATES,
  CALLER_DELAY_SECONDS,
  MAX_NOTIFY_ATTEMPTS,
  TRANSCRIPT_GRACE_MINUTES,
  sweepDueCallbackReminders,
  CALLBACK_REMINDER_LEAD_MINUTES,
  CALLBACK_REMINDER_GRACE_MINUTES,
} from '@/lib/recall-messaging';

const state = {
  callFindUnique: vi.fn(),
  callFindFirst: vi.fn(),
  callFindMany: vi.fn(),
  callUpdate: vi.fn(),
  // Fase 0 — el libro mayor. Tiene que estar mockeado de verdad: recordSend
  // se traga sus propios errores a propósito (ver message-ledger.ts), así
  // que si este doble faltara, los tests seguirían verdes mientras la
  // contabilidad no se escribe. Justo el fallo que el libro mayor existe
  // para no tener.
  outboundMessageCreate: vi.fn(),
};

const prisma = {
  callEvent: {
    findUnique: (...a: unknown[]) => state.callFindUnique(...a),
    findFirst: (...a: unknown[]) => state.callFindFirst(...a),
    findMany: (...a: unknown[]) => state.callFindMany(...a),
    update: (...a: unknown[]) => state.callUpdate(...a),
  },
  outboundMessage: {
    create: (...a: unknown[]) => state.outboundMessageCreate(...a),
  },
} as unknown as PrismaClient;

/** Lo que se apuntó en el libro mayor en esta prueba. */
const ledgerRows = () => state.outboundMessageCreate.mock.calls.map((c) => c[0].data);

// A Tuesday, 11:00 in Madrid — comfortably inside the default hours.
const NOW = new Date('2026-07-07T09:00:00.000Z');
const secondsAgo = (n: number) => new Date(NOW.getTime() - n * 1000);

const CONNECTION = {
  id: 'conn_1',
  externalId: 'phone_1',
  status: 'active',
  accessTokenCiphertext: Buffer.from('c'),
  accessTokenIv: Buffer.from('i'),
  accessTokenTag: Buffer.from('t'),
};

function callRow(overrides: Record<string, unknown> = {}) {
  const { subscription: subOverrides, ...rest } = overrides as {
    subscription?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    id: 'call_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    subscriptionId: 'sub_1',
    fromNumber: '+34651234567',
    withheld: false,
    outcome: 'recorded',
    transcript: 'Hola, llamaba por una fuga en el baño.',
    startedAt: secondsAgo(CALLER_DELAY_SECONDS + 30),
    callerNotifyAttempts: 0,
    ownerNotifyAttempts: 0,
    notifiedCallerAt: null,
    notifiedOwnerAt: null,
    virtualNumber: { e164: '+34910000001' },
    subscription: {
      id: 'sub_1',
      status: 'active',
      ownerWhatsapp: '+34600111222',
      timezone: 'Europe/Madrid',
      businessHours: null,
      metaConnection: CONNECTION,
      client: { name: 'Juan', companyName: 'Fontanería Aurora' },
      ...subOverrides,
    },
    ...rest,
  };
}

let telephony = createFakeTelephonyProvider();

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.decryptMetaToken.mockReset().mockReturnValue('token');
  mockState.sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.isNumberBlocked.mockReset().mockResolvedValue(false);
  state.callUpdate.mockResolvedValue({});
  state.callFindFirst.mockResolvedValue(null);
  state.callFindMany.mockResolvedValue([]);
  telephony = createFakeTelephonyProvider();
});

const run = (overrides: Record<string, unknown> = {}, now = NOW) => {
  state.callFindUnique.mockResolvedValue(callRow(overrides));
  return notifyCaller(prisma, 'call_1', { telephony, now });
};

describe('looksLikeWhatsAppCapable', () => {
  it('knows a Spanish landline will never answer on WhatsApp', () => {
    expect(looksLikeWhatsAppCapable('+34910000001')).toBe(false);
    expect(looksLikeWhatsAppCapable('+34822123456')).toBe(false);
  });

  it('treats Spanish mobiles and every foreign number as worth trying', () => {
    expect(looksLikeWhatsAppCapable('+34651234567')).toBe(true);
    expect(looksLikeWhatsAppCapable('+34711234567')).toBe(true);
    // We cannot read foreign numbering plans, so we try and let 131026
    // tell us. Guessing "landline" would silently downgrade real mobiles.
    expect(looksLikeWhatsAppCapable('+351912345678')).toBe(true);
  });
});

describe('notifyCaller — when not to send', () => {
  it('waits the deliberate 90 seconds', async () => {
    // The owner is often mid-callback in that window; an instant
    // automated reply talks over him.
    await expect(run({ startedAt: secondsAgo(CALLER_DELAY_SECONDS - 10) })).resolves.toEqual({
      status: 'skipped',
      reason: 'not_due',
    });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(state.callUpdate).not.toHaveBeenCalled();
  });

  it('never messages a withheld caller', async () => {
    await expect(run({ withheld: true, fromNumber: null })).resolves.toEqual({
      status: 'skipped',
      reason: 'unreachable',
    });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('refuses a blocked number before spending a single provider call', async () => {
    mockState.isNumberBlocked.mockResolvedValue(true);
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'blocked' });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(telephony.sentSms).toHaveLength(0);
    // Resolved terminally, so the sweep stops reconsidering it...
    expect(state.callUpdate.mock.calls[0][0].data.callerNotifyChannel).toBe('blocked');
    // ...but notifiedCallerAt stays null, because nothing was sent and
    // that column is what the 24h throttle reads.
    expect(state.callUpdate.mock.calls[0][0].data.notifiedCallerAt).toBeUndefined();
  });

  it('sends only once per number per 24h, however many times they ring', async () => {
    state.callFindFirst.mockResolvedValue({ id: 'earlier_call' });
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'throttled' });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(state.callUpdate.mock.calls[0][0].data.callerNotifyChannel).toBe('throttled');

    // The throttle looks at the PERSON, across calls, and excludes the
    // call being handled so it cannot throttle itself.
    const where = state.callFindFirst.mock.calls[0][0].where;
    expect(where.clientId).toBe('client_1');
    expect(where.fromNumber).toBe('+34651234567');
    expect(where.id).toEqual({ not: 'call_1' });
  });

  it('stops when the client paused between the call and the message', async () => {
    // Paused means the client asked us to stop. That includes calls
    // already in flight.
    await expect(run({ subscription: { status: 'paused' } })).resolves.toEqual({
      status: 'skipped',
      reason: 'unreachable',
    });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('notifyCaller — what it says', () => {
  it('promises an immediate reply during business hours', async () => {
    await expect(run()).resolves.toEqual({ status: 'sent', channel: 'whatsapp' });
    const [, phoneNumberId, to, template] = mockState.sendTemplate.mock.calls[0];
    expect(phoneNumberId).toBe('phone_1');
    expect(to).toBe('+34651234567');
    expect(template.name).toBe(RECALL_TEMPLATES.callerOpen.name);
    expect(template.bodyParams).toEqual(['Fontanería Aurora']);
  });

  // Fase 3 — con el negocio cerrado ya no se promete una hora, se OFRECE
  // elegirla, que es el producto de esta fase. 'mañana a las 8:00' era una
  // hora que nadie se había comprometido a cumplir; un hueco elegido sí.
  it('lets the caller pick a time when the business is closed', async () => {
    // 23:40 Madrid on the same Tuesday.
    const night = new Date('2026-07-07T21:40:00.000Z');
    await run({ startedAt: new Date(night.getTime() - 5 * 60 * 1000) }, night);

    const template = mockState.sendTemplate.mock.calls[0][3];
    expect(template.name).toBe(RECALL_TEMPLATES.callerSlots.name);
    const [business, list] = template.bodyParams;
    expect(business).toBe('Fontanería Aurora');
    // Una lista numerada, separada por ' · ' y sin saltos de línea: un
    // '\n' hace que Meta rechace el envío entero.
    expect(list).toMatch(/^1\) .+ · 2\) /);
    expect(list).not.toMatch(/[\n\t]/);
  });

  it('still promises a time when there are no slots to offer', async () => {
    // Un negocio con horario tan estrecho que no salen dos opciones
    // separadas: el mensaje de siempre sigue siendo el correcto.
    const night = new Date('2026-07-07T21:40:00.000Z');
    const narrow = { mon: [], tue: [], wed: [['08:00', '08:30']], thu: [], fri: [], sat: [], sun: [] };
    await run(
      { startedAt: new Date(night.getTime() - 5 * 60 * 1000), subscription: { businessHours: narrow } },
      night,
    );

    const template = mockState.sendTemplate.mock.calls[0][3];
    expect(template.name).toBe(RECALL_TEMPLATES.callerClosed.name);
    expect(template.bodyParams).toEqual(['Fontanería Aurora', 'mañana a las 8:00']);
  });

  it('falls back to vaguer wording rather than an empty parameter', async () => {
    // A client with no open hours at all: describeNextOpening has nothing
    // to offer, and Meta rejects an empty placeholder outright (132000).
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    await run({ subscription: { businessHours: closed } });

    const template = mockState.sendTemplate.mock.calls[0][3];
    expect(template.name).toBe(RECALL_TEMPLATES.callerClosed.name);
    expect(template.bodyParams[1]).toBe('en cuanto abramos');
  });

  it('uses the trading name, falling back to the person', async () => {
    await run({ subscription: { client: { name: 'Juan', companyName: null } } });
    expect(mockState.sendTemplate.mock.calls[0][3].bodyParams[0]).toBe('Juan');
  });
});

describe('notifyCaller — the SMS fallback', () => {
  it('skips WhatsApp entirely for a landline', async () => {
    await expect(run({ fromNumber: '+34910555444' })).resolves.toEqual({ status: 'sent', channel: 'sms' });
    // Trying Meta first would spend a send and a round-trip to learn what
    // the prefix already said.
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(telephony.sentSms).toHaveLength(1);
    expect(telephony.sentSms[0]).toMatchObject({ to: '+34910555444', from: '+34910000001' });
    expect(telephony.sentSms[0].body).toContain('Fontanería Aurora');
  });

  it('falls back after 131026 — and only after 131026', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'undeliverable', code: 131026 });
    await expect(run()).resolves.toEqual({ status: 'sent', channel: 'sms' });
    expect(telephony.sentSms).toHaveLength(1);
  });

  it('does not fall back on a transient WhatsApp failure', async () => {
    // A 500 means try WhatsApp again next tick, not spend an SMS.
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'server error', status: 500 });
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', giveUp: false });
    expect(telephony.sentSms).toHaveLength(0);
  });

  it('gives up immediately on an error repetition cannot fix', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'template paused', code: 132015 });
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', giveUp: true });
    expect(state.callUpdate.mock.calls[0][0].data.callerNotifyChannel).toBe('unreachable');
  });

  it('stops after the attempt budget rather than retrying every five minutes forever', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'server error', status: 500 });
    const result = await run({ callerNotifyAttempts: MAX_NOTIFY_ATTEMPTS - 1 });
    expect(result).toMatchObject({ status: 'failed', giveUp: true });
    const data = state.callUpdate.mock.calls[0][0].data;
    expect(data.callerNotifyAttempts).toBe(MAX_NOTIFY_ATTEMPTS);
    expect(data.callerNotifyChannel).toBe('unreachable');
  });

  it('records the SMS body matching the hours, not just that an SMS went out', async () => {
    const night = new Date('2026-07-07T21:40:00.000Z');
    await run({ fromNumber: '+34910555444', startedAt: new Date(night.getTime() - 5 * 60 * 1000) }, night);
    expect(telephony.sentSms[0].body).toContain('mañana a las 8:00');
  });

  it('reports failure without inventing a channel when there is no number to send from', async () => {
    const result = await run({ fromNumber: '+34910555444', virtualNumber: null });
    expect(result).toMatchObject({ status: 'failed' });
    expect(String((result as { error: string }).error)).toContain('sms_unavailable');
  });
});

// =============================================================================
// Fase 0 — lo que queda apuntado en el libro mayor.
//
// La categoría es la columna por la que existe la tabla: es lo que decide
// el precio. Un contador que no la guarde no se puede desagregar después,
// y por eso estas comprobaciones miran el CONTENIDO de la fila y no solo
// que se haya escrito una.
// =============================================================================
describe('el libro mayor de mensajes', () => {
  it('apunta el envío por WhatsApp con su categoría, su plantilla y el id del proveedor', async () => {
    await run();

    expect(ledgerRows()).toHaveLength(1);
    expect(ledgerRows()[0]).toMatchObject({
      clientId: 'client_1',
      tenantId: 'tenant_1',
      productCode: 'recall',
      channel: 'whatsapp',
      kind: 'template',
      category: 'UTILITY',
      templateName: RECALL_TEMPLATES.callerOpen.name,
      toE164: '+34651234567',
      // La clave para casar esta fila con su línea de la factura.
      providerMessageId: 'wamid.1',
      ok: true,
      callEventId: 'call_1',
    });
  });

  it('apunta TAMBIÉN los envíos fallidos — sin su fila, un hueco en el histórico no tiene explicación', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'rate limited', code: 131048 });
    await run();

    const whatsapp = ledgerRows().filter((r) => r.channel === 'whatsapp');
    expect(whatsapp).toHaveLength(1);
    expect(whatsapp[0]).toMatchObject({ ok: false, error: 'rate limited', providerMessageId: null });
  });

  it('apunta el SMS de respaldo sin categoría — es un concepto de Meta que en SMS no existe', async () => {
    // Un fijo español nunca tiene WhatsApp: se va directo al respaldo.
    await run({ fromNumber: '+34910555444' });

    const sms = ledgerRows().filter((r) => r.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({
      productCode: 'recall',
      channel: 'sms',
      kind: 'free_form',
      category: null,
      toE164: '+34910555444',
      ok: true,
    });
    expect(sms[0].providerMessageId).toBeTruthy();
  });

  it('nace SIEMPRE sin coste: ni Meta ni Twilio lo devuelven en el envío, y una tarifa inventada sería peor que el hueco', async () => {
    await run();
    const row = ledgerRows()[0];
    expect(row.costAmount).toBeUndefined();
    expect(row.costCurrency).toBeUndefined();
  });

  it('no apunta nada cuando no se envió por estar el número bloqueado — no hubo mensaje que contabilizar', async () => {
    mockState.isNumberBlocked.mockResolvedValue(true);
    await run();
    expect(state.outboundMessageCreate).not.toHaveBeenCalled();
  });

  it('un fallo escribiendo el libro mayor NO tumba el envío — la contabilidad no puede costarle la respuesta a quien llamó', async () => {
    state.outboundMessageCreate.mockRejectedValue(new Error('postgres caído'));
    await expect(run()).resolves.toEqual({ status: 'sent', channel: 'whatsapp' });
  });
});

describe('notifyOwner', () => {
  const runOwner = (overrides: Record<string, unknown> = {}, now = NOW) => {
    state.callFindUnique.mockResolvedValue(callRow(overrides));
    return notifyOwner(prisma, 'call_1', { telephony, now });
  };

  it('sends the caller number and the message to the owner', async () => {
    await expect(runOwner()).resolves.toEqual({ status: 'sent' });
    const [, , to, template] = mockState.sendTemplate.mock.calls[0];
    expect(to).toBe('+34600111222');
    expect(template.name).toBe(RECALL_TEMPLATES.ownerMessage.name);
    expect(template.bodyParams[0]).toBe('+34651234567');
    expect(template.bodyParams[1]).toContain('fuga en el baño');
  });

  it('ignores business hours — it is his own phone and his own business', async () => {
    const night = new Date('2026-07-07T21:40:00.000Z');
    await expect(runOwner({}, night)).resolves.toEqual({ status: 'sent' });
  });

  it('tells him about a withheld caller too, in words rather than an empty parameter', async () => {
    await runOwner({ withheld: true, fromNumber: null, outcome: 'withheld', transcript: null });
    const template = mockState.sendTemplate.mock.calls[0][3];
    expect(template.bodyParams[0]).toBe('número oculto');
    expect(template.bodyParams[1]).not.toBe('');
  });

  it('waits briefly for the transcript', async () => {
    await expect(runOwner({ transcript: null, startedAt: secondsAgo(120) })).resolves.toEqual({
      status: 'skipped',
      reason: 'awaiting_transcript',
    });
  });

  it('sends anyway once the grace period expires — Whisper being down must not cancel it', async () => {
    const old = secondsAgo(TRANSCRIPT_GRACE_MINUTES * 60 + 60);
    await expect(runOwner({ transcript: null, startedAt: old })).resolves.toEqual({ status: 'sent' });
    // "alguien llamó y dejó un mensaje" still beats silence.
    expect(mockState.sendTemplate.mock.calls[0][3].bodyParams[1]).toContain('transcribir');
  });

  it('does not wait for a transcript that is never coming', async () => {
    await expect(runOwner({ outcome: 'no_message', transcript: null })).resolves.toEqual({ status: 'sent' });
    expect(mockState.sendTemplate.mock.calls[0][3].bodyParams[1]).toContain('Colgó');
  });

  it('skips silently when the owner never gave us a number', async () => {
    await expect(runOwner({ subscription: { ownerWhatsapp: null } })).resolves.toEqual({
      status: 'skipped',
      reason: 'no_owner_number',
    });
  });

  it('stamps the send only after Meta accepted it', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'boom', status: 500 });
    const result = await runOwner();
    expect(result).toMatchObject({ status: 'failed', giveUp: false });
    // Stamping first would make one transient failure lose the message
    // permanently, because the sweep filters on notifiedOwnerAt.
    expect(state.callUpdate.mock.calls[0][0].data.notifiedOwnerAt).toBeUndefined();
    expect(state.callUpdate.mock.calls[0][0].data.ownerNotifyAttempts).toBe(1);
  });

  it('does not send twice', async () => {
    await expect(runOwner({ notifiedOwnerAt: NOW })).resolves.toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('degrades rather than throwing when the stored token no longer decrypts', async () => {
    mockState.decryptMetaToken.mockImplementation(() => {
      throw new Error('key rotated');
    });
    await expect(runOwner()).resolves.toEqual({ status: 'skipped', reason: 'no_connection' });
  });
});

describe('sweepPendingNotifications', () => {
  it('asks only for calls that still owe someone a message', async () => {
    await sweepPendingNotifications(prisma, { telephony, now: NOW });

    const callerWhere = state.callFindMany.mock.calls[0][0].where;
    // NULL is the only "undecided" value — every terminal outcome, sent
    // or skipped, writes callerNotifyChannel.
    expect(callerWhere.callerNotifyChannel).toBeNull();
    expect(callerWhere.withheld).toBe(false);
    expect(callerWhere.outcome).toEqual({ in: ['recorded', 'no_message'] });
    expect(callerWhere.callerNotifyAttempts).toEqual({ lt: MAX_NOTIFY_ATTEMPTS });
    // The 90-second delay is expressed as a query bound, so it survives a
    // restart in a way a setTimeout never could.
    expect((callerWhere.startedAt.lte as Date).getTime()).toBe(NOW.getTime() - CALLER_DELAY_SECONDS * 1000);
  });

  it('never picks up a blocked or still-ringing call', async () => {
    await sweepPendingNotifications(prisma, { telephony, now: NOW });
    const inList = state.callFindMany.mock.calls[0][0].where.outcome.in;
    expect(inList).not.toContain('blocked');
    expect(inList).not.toContain('pending');
  });

  it('only chases owners whose subscription is live and who gave us a number', async () => {
    await sweepPendingNotifications(prisma, { telephony, now: NOW });
    const ownerWhere = state.callFindMany.mock.calls[1][0].where;
    expect(ownerWhere.subscription).toEqual({ status: 'active', ownerWhatsapp: { not: null } });
    expect(ownerWhere.notifiedOwnerAt).toBeNull();
  });

  it('drains oldest-first, because a backlog is a queue of real people', async () => {
    await sweepPendingNotifications(prisma, { telephony, now: NOW });
    expect(state.callFindMany.mock.calls[0][0].orderBy).toEqual({ startedAt: 'asc' });
  });

  it('counts each outcome so the tick response is usable telemetry', async () => {
    state.callFindMany
      .mockResolvedValueOnce([{ id: 'call_1' }, { id: 'call_2' }])
      .mockResolvedValueOnce([{ id: 'call_1' }]);
    state.callFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'call_2' ? callRow({ id: 'call_2', withheld: true, fromNumber: null }) : callRow(),
    );

    const result = await sweepPendingNotifications(prisma, { telephony, now: NOW });
    expect(result).toMatchObject({
      callersScanned: 2,
      callersSent: 1,
      callersSkipped: 1,
      callersFailed: 0,
      ownersScanned: 1,
      ownersSent: 1,
    });
  });

  it('lets one bad row fail without costing everyone else their turn', async () => {
    state.callFindMany.mockResolvedValueOnce([{ id: 'bad' }, { id: 'call_1' }]).mockResolvedValueOnce([]);
    state.callFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'bad') throw new Error('db blip');
      return callRow();
    });

    const result = await sweepPendingNotifications(prisma, { telephony, now: NOW });
    expect(result.callersFailed).toBe(1);
    expect(result.callersSent).toBe(1);
  });
});

// =============================================================================
// Fase 3 — el recordatorio de la devolución de llamada.
//
// Lo que se fija: que avise a tiempo, que NO avise de una hora que ya pasó
// hace rato, y que una fila que no se puede avisar se cierre en vez de
// mirarse en cada tick para siempre.
// =============================================================================

describe('sweepDueCallbackReminders', () => {
  // Martes 11:00 en Madrid, como el resto del fichero.
  const now = NOW;

  function callbackRow(over: Record<string, unknown> = {}) {
    return {
      ...callRow(),
      id: 'call_cb',
      callbackSlotAt: new Date(now.getTime() + 10 * 60_000),
      ...over,
    };
  }

  beforeEach(() => {
    state.callFindMany.mockResolvedValue([]);
  });

  it('sin devoluciones a la vista no manda nada', async () => {
    const result = await sweepDueCallbackReminders(prisma, { now });
    expect(result).toEqual({ scanned: 0, sent: 0, expired: 0, failed: 0 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('avisa al dueño con a quién llamar y a qué hora', async () => {
    state.callFindMany.mockResolvedValue([callbackRow()]);

    const result = await sweepDueCallbackReminders(prisma, { now });

    expect(result).toMatchObject({ scanned: 1, sent: 1 });
    const [, phoneNumberId, to, template] = mockState.sendTemplate.mock.calls[0];
    expect(phoneNumberId).toBe('phone_1');
    // Al WhatsApp del DUEÑO, no al número público del negocio.
    expect(to).toBe('+34600111222');
    expect(template.name).toBe(RECALL_TEMPLATES.ownerCallback.name);
    expect(template.bodyParams[0]).toBe('+34651234567');
    // La hora va en la zona del negocio, no en la del servidor.
    expect(template.bodyParams[1]).toMatch(/^a las \d{2}:\d{2}$/);
    expect(state.callUpdate).toHaveBeenCalledWith({
      where: { id: 'call_cb' },
      data: { callbackRemindedAt: now },
    });
  });

  it('solo busca las que están dentro del margen de aviso', async () => {
    await sweepDueCallbackReminders(prisma, { now });
    const where = state.callFindMany.mock.calls[0][0].where;
    expect(where.callbackRemindedAt).toBeNull();
    expect(where.callbackSlotAt.lte).toEqual(
      new Date(now.getTime() + CALLBACK_REMINDER_LEAD_MINUTES * 60_000),
    );
  });

  it('una hora que ya pasó hace rato se cierra sin avisar', async () => {
    // Un recordatorio con dos horas de retraso no es un aviso.
    const late = new Date(now.getTime() - (CALLBACK_REMINDER_GRACE_MINUTES + 90) * 60_000);
    state.callFindMany.mockResolvedValue([callbackRow({ callbackSlotAt: late })]);

    const result = await sweepDueCallbackReminders(prisma, { now });

    expect(result).toMatchObject({ scanned: 1, sent: 0, expired: 1 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    // Estampado igualmente, para que no reaparezca en cada tick.
    expect(state.callUpdate).toHaveBeenCalledWith({
      where: { id: 'call_cb' },
      data: { callbackRemindedAt: now },
    });
  });

  it('dentro de la gracia sí avisa, aunque llegue tarde', async () => {
    const slightlyLate = new Date(now.getTime() - 5 * 60_000);
    state.callFindMany.mockResolvedValue([callbackRow({ callbackSlotAt: slightlyLate })]);
    await expect(sweepDueCallbackReminders(prisma, { now })).resolves.toMatchObject({ sent: 1 });
  });

  it('una suscripción pausada es un cliente que pidió que paremos', async () => {
    state.callFindMany.mockResolvedValue([
      callbackRow({ subscription: { ...callRow().subscription, status: 'paused' } }),
    ]);

    const result = await sweepDueCallbackReminders(prisma, { now });

    expect(result).toMatchObject({ expired: 1, sent: 0 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('sin número del dueño se cierra, en vez de reintentarse hasta caducar', async () => {
    state.callFindMany.mockResolvedValue([
      callbackRow({ subscription: { ...callRow().subscription, ownerWhatsapp: null } }),
    ]);

    const result = await sweepDueCallbackReminders(prisma, { now });

    expect(result).toMatchObject({ expired: 1 });
    expect(state.callUpdate).toHaveBeenCalled();
  });

  it('un envío fallido NO se estampa: se reintenta mientras la hora siga valiendo', async () => {
    state.callFindMany.mockResolvedValue([callbackRow()]);
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'graph down', code: 500 });

    const result = await sweepDueCallbackReminders(prisma, { now });

    expect(result).toMatchObject({ failed: 1, sent: 0 });
    // Sin estampar, así que el tick siguiente lo vuelve a intentar; lo que
    // acota los reintentos es la ventana de gracia, no un contador.
    expect(state.callUpdate).not.toHaveBeenCalled();
  });
});
