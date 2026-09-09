// =============================================================================
// Fase 3 — unit tests para src/lib/recall-callbacks.ts.
//
// Lo que se fija aquí es lo que decide si a un desconocido se le promete
// bien o mal:
//
//   • Que el «2» se resuelva contra los huecos que se le ENVIARON, no
//     contra unos recalculados ahora, que serían otras horas.
//   • Que dos personas no se lleven el mismo hueco.
//   • Que un mensaje de alguien sin oferta abierta salga 'ignored' y no
//     como una elección inventada.
//   • Que no lance: cuelga de la misma ruta por la que el dueño contesta
//     su digest.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  logError: vi.fn(),
  decryptMetaToken: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/meta-business', () => ({ decryptMetaToken: (...a: unknown[]) => mockState.decryptMetaToken(...a) }));
vi.mock('@/lib/whatsapp-api', () => ({ sendMessage: (...a: unknown[]) => mockState.sendMessage(...a) }));

import {
  applyCallbackReply,
  callbackReplyText,
  sendCallbackReply,
  CALLBACK_REPLY_WINDOW_HOURS,
} from '@/lib/recall-callbacks';

const NOW = new Date('2026-09-07T18:00:00.000Z');
const SLOT_A = new Date('2026-09-08T07:00:00.000Z');
const SLOT_B = new Date('2026-09-08T10:00:00.000Z');

const OFFERED = [
  { at: SLOT_A.toISOString(), label: 'mañana a las 9:00' },
  { at: SLOT_B.toISOString(), label: 'mañana a las 12:00' },
];

const state = {
  findMany: vi.fn(),
  update: vi.fn(),
  connectionFindFirst: vi.fn(),
};

const prisma = {
  callEvent: {
    findMany: (...a: unknown[]) => state.findMany(...a),
    update: (...a: unknown[]) => state.update(...a),
  },
  metaChannelConnection: { findFirst: (...a: unknown[]) => state.connectionFindFirst(...a) },
} as unknown as PrismaClient;

function offerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'call_1',
    clientId: 'c1',
    fromNumber: '+34651234567',
    callbackOfferedSlots: OFFERED,
    callbackOfferedAt: new Date('2026-09-07T17:30:00.000Z'),
    callbackSlotAt: null,
    ...over,
  };
}

const INPUT = { subscriptionId: 'sub_1', from: '34651234567', text: '1', now: NOW };

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  for (const fn of Object.values(mockState)) fn.mockReset();
  // Por defecto: una oferta abierta y ningún hueco cogido.
  state.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
    Promise.resolve('callbackOfferedAt' in (args.where ?? {}) ? [offerRow()] : []),
  );
  state.update.mockResolvedValue({});
});

describe('applyCallbackReply — a quién pertenece la respuesta', () => {
  it('casa el wa_id sin «+» con el número guardado en E.164', async () => {
    const result = await applyCallbackReply(prisma, INPUT);
    expect(result).toMatchObject({ status: 'scheduled' });
  });

  it('un número sin oferta abierta se ignora, para que siga como conversación', async () => {
    const result = await applyCallbackReply(prisma, { ...INPUT, from: '34600999888' });
    expect(result).toEqual({ status: 'ignored', reason: 'no_open_offer' });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('solo mira las ofertas dentro de la ventana de respuesta', async () => {
    await applyCallbackReply(prisma, INPUT);
    const where = state.findMany.mock.calls[0][0].where;
    expect(where.callbackOfferedAt.gte).toEqual(
      new Date(NOW.getTime() - CALLBACK_REPLY_WINDOW_HOURS * 60 * 60_000),
    );
  });

  it('quien ya eligió no vuelve a elegir', async () => {
    state.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve('callbackOfferedAt' in (args.where ?? {}) ? [offerRow({ callbackSlotAt: SLOT_A })] : []),
    );
    const result = await applyCallbackReply(prisma, { ...INPUT, text: '2' });
    expect(result).toEqual({ status: 'ignored', reason: 'already_chosen' });
    expect(state.update).not.toHaveBeenCalled();
  });
});

describe('applyCallbackReply — resolver la elección', () => {
  it('apunta el hueco que eligió, leído del array guardado', async () => {
    const result = await applyCallbackReply(prisma, { ...INPUT, text: '2' });
    expect(result).toMatchObject({ status: 'scheduled', slot: { label: 'mañana a las 12:00' } });
    expect(state.update).toHaveBeenCalledWith({
      where: { id: 'call_1' },
      data: { callbackSlotAt: SLOT_B, callbackChosenAt: NOW },
    });
  });

  it('un «ninguno» no apunta nada', async () => {
    const result = await applyCallbackReply(prisma, { ...INPUT, text: 'ninguna me viene bien' });
    expect(result).toEqual({ status: 'declined' });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('un mensaje que no se entiende no inventa una elección', async () => {
    const result = await applyCallbackReply(prisma, { ...INPUT, text: 'buenas, gracias' });
    expect(result).toEqual({ status: 'unclear' });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('una columna de huecos corrupta se trata como si no hubiera oferta', async () => {
    state.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve('callbackOfferedAt' in (args.where ?? {}) ? [offerRow({ callbackOfferedSlots: 'roto' })] : []),
    );
    expect(await applyCallbackReply(prisma, INPUT)).toEqual({ status: 'ignored', reason: 'no_open_offer' });
  });
});

describe('applyCallbackReply — dos personas, un hueco', () => {
  function withTaken(taken: Date[]) {
    state.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        'callbackOfferedAt' in (args.where ?? {})
          ? [offerRow()]
          : taken.map((at) => ({ callbackSlotAt: at })),
      ),
    );
  }

  it('si el hueco pedido ya está cogido, mueve al siguiente que le ofrecimos', async () => {
    withTaken([SLOT_A]);
    const result = await applyCallbackReply(prisma, { ...INPUT, text: '1' });
    expect(result).toMatchObject({
      status: 'scheduled',
      slot: { label: 'mañana a las 12:00' },
      movedFrom: { label: 'mañana a las 9:00' },
    });
  });

  it('nunca mueve a una hora ANTERIOR a la que eligió', async () => {
    // Pide el segundo y está cogido: el primero es antes, así que no vale.
    withTaken([SLOT_B]);
    const result = await applyCallbackReply(prisma, { ...INPUT, text: '2' });
    expect(result).toEqual({ status: 'no_slot_free' });
  });

  it('sin ningún hueco libre de los suyos, no elige por él', async () => {
    withTaken([SLOT_A, SLOT_B]);
    expect(await applyCallbackReply(prisma, { ...INPUT, text: '1' })).toEqual({ status: 'no_slot_free' });
    expect(state.update).not.toHaveBeenCalled();
  });
});

describe('applyCallbackReply — nunca lanza', () => {
  it('un fallo de base de datos no puede tumbar la ruta del digest del dueño', async () => {
    state.findMany.mockRejectedValue(new Error('db down'));
    expect(await applyCallbackReply(prisma, INPUT)).toEqual({ status: 'ignored', reason: 'no_open_offer' });
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_callbacks.apply_failed',
      expect.any(Error),
      { subscriptionId: 'sub_1' },
      'warn',
    );
  });
});

describe('callbackReplyText', () => {
  const slot = { at: SLOT_A, label: 'mañana a las 9:00' };

  it('confirma con la hora exacta', () => {
    const text = callbackReplyText({ status: 'scheduled', slot }, 'Fontanería Aurora')!;
    expect(text).toContain('mañana a las 9:00');
  });

  it('cuando ha habido que moverle, lo dice en vez de callarlo', () => {
    const text = callbackReplyText(
      { status: 'scheduled', slot, movedFrom: { at: SLOT_B, label: 'mañana a las 12:00' } },
      'Fontanería Aurora',
    )!;
    expect(text).toContain('se acaba de ocupar');
    expect(text).toContain('mañana a las 9:00');
  });

  it('si no le vale ninguna, le pide la hora en vez de dejarlo colgado', () => {
    const text = callbackReplyText({ status: 'declined' }, 'Fontanería Aurora')!;
    expect(text).toContain('Fontanería Aurora');
    expect(text.toLowerCase()).toContain('hora');
  });

  it('a un mensaje que no se entiende se le explica cómo contestar', () => {
    expect(callbackReplyText({ status: 'unclear' }, 'X')).toContain('número');
  });

  it('a lo que no era una respuesta nuestra no se le contesta nada', () => {
    expect(callbackReplyText({ status: 'ignored', reason: 'no_open_offer' }, 'X')).toBeNull();
    expect(callbackReplyText({ status: 'ignored', reason: 'already_chosen' }, 'X')).toBeNull();
  });
});

describe('sendCallbackReply', () => {
  beforeEach(() => {
    state.connectionFindFirst.mockResolvedValue({
      externalId: 'phone_1',
      accessTokenCiphertext: Buffer.from(''),
      accessTokenIv: Buffer.from(''),
      accessTokenTag: Buffer.from(''),
    });
    mockState.decryptMetaToken.mockReturnValue('tok');
    mockState.sendMessage.mockResolvedValue({ ok: true, data: {} });
  });

  it('contesta con un mensaje libre, no con una plantilla', async () => {
    // Quien llamó acaba de escribirnos: la ventana de 24 horas está
    // abierta, así que no hace falta plantilla ni aprobación de Meta.
    expect(await sendCallbackReply(prisma, { clientId: 'c1', to: '34651234567', text: 'Hecho' })).toEqual({ ok: true });
    expect(mockState.sendMessage).toHaveBeenCalledWith('tok', 'phone_1', '34651234567', 'Hecho');
  });

  it('sin conexión activa no finge que ha enviado', async () => {
    state.connectionFindFirst.mockResolvedValue(null);
    expect(await sendCallbackReply(prisma, { clientId: 'c1', to: 'x', text: 'y' })).toEqual({ ok: false });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it('nunca lanza: la devolución ya quedó apuntada antes de llegar aquí', async () => {
    mockState.sendMessage.mockRejectedValue(new Error('graph down'));
    expect(await sendCallbackReply(prisma, { clientId: 'c1', to: 'x', text: 'y' })).toEqual({ ok: false });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
