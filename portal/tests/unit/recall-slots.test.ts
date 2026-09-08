// =============================================================================
// Fase 3 — unit tests para src/lib/recall-slots.ts.
//
// Todo puro, así que aquí se fija lo que de verdad decide si esto funciona
// o le miente a un desconocido:
//
//   • Que ningún hueco caiga fuera del horario del negocio. Ofrecer las
//     22:00 de un domingo es prometer una llamada que no va a existir.
//   • Que las opciones estén separadas: «10:00, 10:30, 11:00» no es
//     elegir.
//   • Que el orden se lea del array guardado y no se recalcule, o el «2»
//     de quien llamó se resolvería a una hora distinta de la que vio.
// =============================================================================

import { describe, it, expect } from 'vitest';
import type { BusinessHours } from '@/lib/recall-hours';
import { DEFAULT_BUSINESS_HOURS, isWithinBusinessHours } from '@/lib/recall-hours';
import {
  buildCallbackSlots,
  buildSlotList,
  formatSlotLabel,
  parseSlotChoice,
  slotsToJson,
  slotsFromJson,
  MAX_OFFERED_SLOTS,
  MIN_OFFERED_SLOTS,
  SLOT_LEAD_MINUTES,
  SLOT_SPACING_MINUTES,
  SLOT_HORIZON_DAYS,
} from '@/lib/recall-slots';

const TZ = 'Europe/Madrid';

// Lunes 7 de septiembre de 2026, 09:10 en Madrid (07:10 UTC en verano).
const MONDAY_MORNING = new Date('2026-09-07T07:10:00.000Z');

const NEVER_OPEN: BusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

describe('buildCallbackSlots', () => {
  it('ofrece tres opciones dentro del horario', () => {
    const slots = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ);
    expect(slots).toHaveLength(MAX_OFFERED_SLOTS);
    for (const slot of slots) {
      expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, slot.at, TZ)).toBe(true);
    }
  });

  it('ninguna opción cae antes del margen mínimo', () => {
    const slots = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ);
    const earliest = MONDAY_MORNING.getTime() + SLOT_LEAD_MINUTES * 60_000;
    for (const slot of slots) {
      expect(slot.at.getTime()).toBeGreaterThanOrEqual(earliest);
    }
  });

  it('separa las opciones, para que elegir signifique algo', () => {
    const slots = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].at.getTime() - slots[i - 1].at.getTime()).toBeGreaterThanOrEqual(
        SLOT_SPACING_MINUTES * 60_000,
      );
    }
  });

  it('van en orden', () => {
    const slots = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ);
    const times = slots.map((s) => s.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('un negocio que no abre nunca no genera oferta, en vez de una vacía', () => {
    expect(buildCallbackSlots(NEVER_OPEN, MONDAY_MORNING, TZ)).toEqual([]);
  });

  it('salta el hueco que ya tiene otra persona', () => {
    const first = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ);
    const second = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ, {
      taken: [first[0].at],
    });
    expect(second.map((s) => s.at.getTime())).not.toContain(first[0].at.getTime());
    expect(second).toHaveLength(MAX_OFFERED_SLOTS);
  });

  it('un sábado por la tarde salta al lunes, no ofrece el domingo', () => {
    // Sábado 12 de septiembre de 2026, 15:00 en Madrid: el horario por
    // defecto cierra los sábados a las 13:00 y el domingo entero.
    const saturday = new Date('2026-09-12T13:00:00.000Z');
    const slots = buildCallbackSlots(DEFAULT_BUSINESS_HOURS, saturday, TZ);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(isWithinBusinessHours(DEFAULT_BUSINESS_HOURS, slot.at, TZ)).toBe(true);
      // Ninguna cae en domingo.
      const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(slot.at);
      expect(day).not.toBe('Sun');
    }
  });

  it('no mira más allá del horizonte', () => {
    // Solo abre los jueves: desde un lunes, el jueves entra en el
    // horizonte de tres días; un negocio que solo abre el viernes, no.
    const fridayOnly: BusinessHours = { ...NEVER_OPEN, fri: [['09:00', '13:00']] };
    const slots = buildCallbackSlots(fridayOnly, MONDAY_MORNING, TZ);
    expect(slots).toEqual([]);

    const horizon = MONDAY_MORNING.getTime() + SLOT_HORIZON_DAYS * 24 * 60 * 60_000;
    const thursdayOnly: BusinessHours = { ...NEVER_OPEN, thu: [['09:00', '13:00']] };
    for (const slot of buildCallbackSlots(thursdayOnly, MONDAY_MORNING, TZ)) {
      expect(slot.at.getTime()).toBeLessThanOrEqual(horizon);
    }
  });

  it('respeta el máximo pedido', () => {
    expect(buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ, { max: 1 })).toHaveLength(1);
    expect(buildCallbackSlots(DEFAULT_BUSINESS_HOURS, MONDAY_MORNING, TZ, { max: 0 })).toEqual([]);
  });

  it('los topes son decisiones de producto, no números sueltos', () => {
    expect(MAX_OFFERED_SLOTS).toBe(3);
    expect(MIN_OFFERED_SLOTS).toBe(2);
  });
});

describe('formatSlotLabel', () => {
  it('dice hoy, mañana o el día de la semana', () => {
    const today = new Date('2026-09-07T15:30:00.000Z'); // 17:30 en Madrid
    expect(formatSlotLabel(today, MONDAY_MORNING, TZ)).toBe('hoy a las 17:30');

    const tomorrow = new Date('2026-09-08T07:00:00.000Z'); // martes 09:00
    expect(formatSlotLabel(tomorrow, MONDAY_MORNING, TZ)).toBe('mañana a las 9:00');

    const later = new Date('2026-09-09T09:00:00.000Z'); // miércoles 11:00
    expect(formatSlotLabel(later, MONDAY_MORNING, TZ)).toBe('el miércoles a las 11:00');
  });

  it('usa la zona del negocio, no la del servidor', () => {
    const at = new Date('2026-09-07T15:30:00.000Z');
    expect(formatSlotLabel(at, MONDAY_MORNING, 'Atlantic/Canary')).toBe('hoy a las 16:30');
  });
});

describe('buildSlotList', () => {
  it('numera y separa con puntos, nunca con saltos de línea', () => {
    const slots = [
      { at: new Date('2026-09-07T15:30:00.000Z'), label: 'hoy a las 17:30' },
      { at: new Date('2026-09-08T07:00:00.000Z'), label: 'mañana a las 9:00' },
    ];
    const list = buildSlotList(slots);
    expect(list).toBe('1) hoy a las 17:30 · 2) mañana a las 9:00');
    // Un '\n' aquí hace que Meta rechace el envío entero con un 400 que no
    // se reintenta: el mensaje no llegaría nunca.
    expect(list).not.toMatch(/[\n\t]/);
  });
});

describe('parseSlotChoice', () => {
  it('entiende un número suelto', () => {
    expect(parseSlotChoice('2', 3)).toEqual({ kind: 'slot', index: 2 });
  });

  it('entiende cómo escribe la gente de verdad', () => {
    expect(parseSlotChoice('el 2', 3)).toEqual({ kind: 'slot', index: 2 });
    expect(parseSlotChoice('me viene bien la 3, gracias', 3)).toEqual({ kind: 'slot', index: 3 });
    expect(parseSlotChoice('  1  ', 3)).toEqual({ kind: 'slot', index: 1 });
  });

  it('con varios números se queda con el primero: es una elección única', () => {
    expect(parseSlotChoice('la 1 o la 2', 3)).toEqual({ kind: 'slot', index: 1 });
  });

  it('ignora los números fuera de rango en vez de fallar entero', () => {
    expect(parseSlotChoice('la 9 o la 3', 3)).toEqual({ kind: 'slot', index: 3 });
    expect(parseSlotChoice('7', 3)).toEqual({ kind: 'unclear' });
  });

  it('reconoce que no le vale ninguna, con y sin acento', () => {
    for (const text of ['ninguno', 'ninguna', 'ningún', 'no', 'nada', '0']) {
      expect(parseSlotChoice(text, 3)).toEqual({ kind: 'none' });
    }
  });

  // El caso ambiguo de verdad, y por qué se resuelve así. Una negación
  // suelta junto a un número puede ser un rechazo ('no puedo el 2') o una
  // corrección ('el 2 no, el 3'), y distinguirlos exige entender la frase.
  // Se elige el rechazo porque los dos errores no cuestan lo mismo: leer
  // un rechazo como elección le promete a alguien una llamada a una hora
  // que acaba de decir que no le vale; leer una corrección como rechazo
  // solo hace que le pidamos que nos diga él la hora.
  it('una negación gana sobre el número que la acompaña', () => {
    expect(parseSlotChoice('no puedo el 2', 3)).toEqual({ kind: 'none' });
    expect(parseSlotChoice('el 2 no', 3)).toEqual({ kind: 'none' });
  });

  it('un mensaje sin nada usable es unclear, no una elección inventada', () => {
    expect(parseSlotChoice('hola buenas', 3)).toEqual({ kind: 'unclear' });
    expect(parseSlotChoice('', 3)).toEqual({ kind: 'unclear' });
  });
});

describe('slotsToJson / slotsFromJson', () => {
  const slots = [
    { at: new Date('2026-09-07T15:30:00.000Z'), label: 'hoy a las 17:30' },
    { at: new Date('2026-09-08T07:00:00.000Z'), label: 'mañana a las 9:00' },
  ];

  it('ida y vuelta sin perder ni el orden ni la hora', () => {
    expect(slotsFromJson(slotsToJson(slots))).toEqual(slots);
  });

  it('una columna corrupta no tumba la respuesta a quien está esperando', () => {
    expect(slotsFromJson(null)).toEqual([]);
    expect(slotsFromJson('vaya')).toEqual([]);
    expect(slotsFromJson([{ at: 'no es una fecha', label: 'x' }])).toEqual([]);
    expect(slotsFromJson([null, { label: 'sin fecha' }])).toEqual([]);
  });

  it('descarta solo las entradas malas, conserva las buenas', () => {
    const mixed = [...slotsToJson(slots), { at: 'roto' }];
    expect(slotsFromJson(mixed)).toHaveLength(2);
  });
});
