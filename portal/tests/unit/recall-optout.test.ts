// =============================================================================
// Fase 0 — tests del aviso de oposición y la baja.
//
// El peso está en isOptOutRequest, y concretamente en los FALSOS
// POSITIVOS. La detección es deliberadamente generosa, pero la baja es
// irreversible (recall-blocklist.ts se niega a deshacerla), así que cada
// falso positivo suprime para siempre a alguien que no lo pidió. Esa
// asimetría es la que estos tests vigilan.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  isOptOutRequest,
  applyOptOut,
  LEGAL_NOTICE_TEXT,
  LEGAL_NOTICE_VERSION,
  OPT_OUT_CONFIRMATION,
  OPT_OUT_REASON,
} from '@/lib/recall-optout';

const state = {
  blockedFindUnique: vi.fn(),
  blockedUpsert: vi.fn(),
};

const prisma = {
  recallBlockedNumber: {
    findUnique: (...a: unknown[]) => state.blockedFindUnique(...a),
    upsert: (...a: unknown[]) => state.blockedUpsert(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.blockedFindUnique.mockResolvedValue(null);
  state.blockedUpsert.mockResolvedValue({ id: 'blk_1' });
});

describe('isOptOutRequest — lo que SÍ es una baja', () => {
  it('reconoce la palabra de la plantilla escrita de cualquier forma', () => {
    for (const text of ['BAJA', 'baja', '  Baja  ', '¡BAJA!', 'Baja.']) {
      expect(isOptOutRequest(text)).toBe(true);
    }
  });

  it('reconoce las formas naturales, no solo la palabra mágica — la FCC obliga a atender la revocación por cualquier medio razonable', () => {
    for (const text of [
      'no me escribáis más',
      'No me escribas',
      'quiero darme de baja',
      'me doy de baja',
      'dejadme en paz',
      'no quiero recibir más mensajes',
      'basta',
      'borradme',
    ]) {
      expect(isOptOutRequest(text)).toBe(true);
    }
  });

  it('reconoce el inglés: un turista escribe STOP, no BAJA', () => {
    expect(isOptOutRequest('stop')).toBe(true);
    expect(isOptOutRequest('STOP')).toBe(true);
    expect(isOptOutRequest('unsubscribe')).toBe(true);
  });

  it('acepta la palabra dentro de una frase corta', () => {
    expect(isOptOutRequest('baja por favor')).toBe(true);
    expect(isOptOutRequest('stop please')).toBe(true);
  });
});

describe('isOptOutRequest — los falsos positivos que arruinarían a un cliente', () => {
  // El caso concreto que motivó el límite de longitud. Esta persona está
  // pidiendo que la llamen, y una baja irreversible la borraría en
  // silencio.
  it('NO lee como baja una frase larga que casualmente contiene una negación', () => {
    expect(isOptOutRequest('no puedo el martes, mejor llamadme el miércoles')).toBe(false);
    expect(isOptOutRequest('el 2 no me viene bien, prefiero por la tarde si puede ser')).toBe(false);
  });

  it('NO lee como baja un «no» a secas — a una oferta de huecos significa «ninguno me vale»', () => {
    expect(isOptOutRequest('no')).toBe(false);
    expect(isOptOutRequest('No.')).toBe(false);
  });

  it('NO lee como baja la elección de un hueco, que es la respuesta normal a recall_caller_slots', () => {
    for (const text of ['1', '2', 'el 1', 'la 2 gracias']) {
      expect(isOptOutRequest(text)).toBe(false);
    }
  });

  it('NO lee como baja una conversación corriente', () => {
    expect(isOptOutRequest('hola, quería pedir cita')).toBe(false);
    expect(isOptOutRequest('gracias')).toBe(false);
    expect(isOptOutRequest('')).toBe(false);
    expect(isOptOutRequest('   ')).toBe(false);
  });

  it('NO confunde «bajar» con «baja» — la comparación es por palabra entera', () => {
    expect(isOptOutRequest('voy a bajar ahora')).toBe(false);
  });
});

describe('applyOptOut', () => {
  const input = { subscriptionId: 'sub_1', clientId: 'client_1', from: '+34651234567', text: 'BAJA' };

  it('sella optOutAt y firma la fila como pedida por el llamante, no por el dueño', async () => {
    const now = new Date('2026-09-14T10:00:00Z');
    const result = await applyOptOut(prisma, { ...input, now });

    expect(result).toEqual({ status: 'suppressed', e164: '+34651234567', alreadySuppressed: false });
    const call = state.blockedUpsert.mock.calls[0][0];
    expect(call.create).toMatchObject({
      subscriptionId: 'sub_1',
      clientId: 'client_1',
      e164: '+34651234567',
      reason: OPT_OUT_REASON,
      createdBy: 'caller:+34651234567',
      optOutAt: now,
    });
  });

  it('normaliza el número a E.164 — si guardara lo que llega de Meta, la lista no casaría nunca con lo que manda Twilio', async () => {
    await applyOptOut(prisma, { ...input, from: '651 23 45 67' });
    expect(state.blockedUpsert.mock.calls[0][0].create.e164).toBe('+34651234567');
  });

  it('no hace nada cuando el mensaje no es una baja', async () => {
    const result = await applyOptOut(prisma, { ...input, text: 'quiero cita el jueves' });
    expect(result).toEqual({ status: 'ignored', reason: 'not_an_opt_out' });
    expect(state.blockedUpsert).not.toHaveBeenCalled();
  });

  it('avisa de que ya estaba dada de baja, para que la ruta no mande una segunda confirmación', async () => {
    state.blockedFindUnique.mockResolvedValue({ optOutAt: new Date('2026-09-01T00:00:00Z') });
    const result = await applyOptOut(prisma, input);
    expect(result).toMatchObject({ status: 'suppressed', alreadySuppressed: true });
  });

  it('NUNCA reescribe la fecha de una baja ya sellada — repetir «BAJA» no reinicia el reloj', async () => {
    const original = new Date('2026-09-01T00:00:00Z');
    state.blockedFindUnique.mockResolvedValue({ optOutAt: original });
    await applyOptOut(prisma, { ...input, now: new Date('2026-09-14T10:00:00Z') });
    expect(state.blockedUpsert.mock.calls[0][0].update).toEqual({ optOutAt: original });
  });

  it('sella la baja sobre un bloqueo que ya había puesto el dueño, volviéndolo irreversible', async () => {
    const now = new Date('2026-09-14T10:00:00Z');
    state.blockedFindUnique.mockResolvedValue({ optOutAt: null });
    await applyOptOut(prisma, { ...input, now });
    expect(state.blockedUpsert.mock.calls[0][0].update).toEqual({ optOutAt: now });
  });

  it('rechaza un número ilegible en vez de guardar una fila que no casará con nada', async () => {
    const result = await applyOptOut(prisma, { ...input, from: 'xxx' });
    expect(result).toEqual({ status: 'ignored', reason: 'invalid_number' });
    expect(state.blockedUpsert).not.toHaveBeenCalled();
  });
});

describe('los textos', () => {
  it('el aviso dice cómo salirse y nombra la palabra que isOptOutRequest sí reconoce', () => {
    expect(LEGAL_NOTICE_TEXT).toMatch(/BAJA/);
    // El contrato entre lo que se promete y lo que se atiende: si alguien
    // cambia la palabra del aviso sin enseñársela al detector, la salida
    // que ofrecemos deja de funcionar y nadie se entera.
    const promised = LEGAL_NOTICE_TEXT.match(/\b([A-ZÁÉÍÓÚÑ]{3,})\b/)?.[1];
    expect(promised).toBeTruthy();
    expect(isOptOutRequest(promised as string)).toBe(true);
  });

  it('la versión del aviso está puesta, porque es lo que se sella como evidencia', () => {
    expect(LEGAL_NOTICE_VERSION).toMatch(/^\d{4}-\d{2}-v\d+$/);
  });

  it('la confirmación de baja no lleva ni una palabra comercial', () => {
    expect(OPT_OUT_CONFIRMATION).not.toMatch(/oferta|descuento|promoc|vuelve|seguro\?/i);
  });
});
