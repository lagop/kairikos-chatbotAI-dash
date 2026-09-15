// =============================================================================
// Fase 2 — tests de la captura de trabajo por voz.
//
// Casi todo el peso está en el parseo, y a propósito: es una función pura,
// así que se puede probar contra respuestas malas de verdad sin tocar la
// red. Y las respuestas malas son el caso normal aquí — la entrada es una
// nota de voz dictada de pie y con ruido.
//
// El criterio que guía todo el fichero: ANTE LA DUDA, null. Un importe
// inventado que parece razonable es peor que un hueco, porque el hueco se
// ve y el importe se cobra.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { parseJobCaptureResponse, nextServiceDate } from '@/lib/job-capture-ai';

/** La nota de voz del ejemplo canónico, ya extraída. */
const GARCIA = JSON.stringify({
  kind: 'job',
  contactName: 'García',
  contactHint: 'calle Mayor 14',
  serviceType: 'cambio de termo eléctrico',
  amount: 340,
  currency: 'EUR',
  equipment: null,
  nextServiceMonths: 12,
  description: 'Cambio de termo eléctrico',
});

describe('parseJobCaptureResponse', () => {
  it('extrae el caso canónico entero', () => {
    expect(parseJobCaptureResponse(GARCIA)).toEqual({
      kind: 'job',
      contactName: 'García',
      contactHint: 'calle Mayor 14',
      serviceType: 'cambio de termo eléctrico',
      amount: 340,
      currency: 'EUR',
      equipment: null,
      nextServiceMonths: 12,
      description: 'Cambio de termo eléctrico',
    });
  });

  // El fallo que tumbó el 100% de un barrido real de clasificación de
  // leads, documentado en ai-json.ts. Haiku envuelve el JSON en ```json
  // aunque el prompt le diga explícitamente que no lo haga.
  it('sobrevive a la valla de markdown que el modelo pone igualmente', () => {
    expect(parseJobCaptureResponse('```json\n' + GARCIA + '\n```')?.amount).toBe(340);
  });

  it('devuelve null solo cuando la respuesta no es utilizable en absoluto', () => {
    expect(parseJobCaptureResponse('lo siento, no he entendido')).toBeNull();
    expect(parseJobCaptureResponse('[]')).toBeNull();
    expect(parseJobCaptureResponse('null')).toBeNull();
    expect(parseJobCaptureResponse('')).toBeNull();
  });

  it('un objeto incompleto NO es null: el 80% de lo pedido sigue ahorrando el 80% de teclear', () => {
    const parsed = parseJobCaptureResponse('{"kind":"job","contactName":"García"}');
    expect(parsed).toMatchObject({ kind: 'job', contactName: 'García', amount: null });
  });

  it('un kind desconocido cae en unclear en vez de colarse tal cual', () => {
    expect(parseJobCaptureResponse('{"kind":"factura"}')?.kind).toBe('unclear');
    expect(parseJobCaptureResponse('{"kind":123}')?.kind).toBe('unclear');
  });

  // 'unclear' es un desenlace legítimo, no un error: forzar toda nota a ser
  // trabajo o presupuesto llenaría la base de trabajos fantasma de 0 €.
  it('acepta unclear como respuesta válida', () => {
    const parsed = parseJobCaptureResponse('{"kind":"unclear","description":"recordar llamar a Pepe"}');
    expect(parsed?.kind).toBe('unclear');
  });
});

describe('parseJobCaptureResponse — los importes', () => {
  it('rechaza un importe negativo: -340 € es un error de transcripción, no un abono', () => {
    expect(parseJobCaptureResponse('{"kind":"job","amount":-340}')?.amount).toBeNull();
  });

  it('acepta el cero, que sí es un importe real (una visita de garantía)', () => {
    expect(parseJobCaptureResponse('{"kind":"job","amount":0}')?.amount).toBe(0);
  });

  it('rechaza un importe que vino como texto en vez de número', () => {
    expect(parseJobCaptureResponse('{"kind":"job","amount":"340 euros"}')?.amount).toBeNull();
  });

  it('rechaza NaN e Infinity', () => {
    expect(parseJobCaptureResponse('{"kind":"job","amount":1e999}')?.amount).toBeNull();
  });
});

describe('parseJobCaptureResponse — los meses hasta la revisión', () => {
  it('redondea un número con decimales', () => {
    expect(parseJobCaptureResponse('{"kind":"job","nextServiceMonths":11.7}')?.nextServiceMonths).toBe(12);
  });

  it('descarta el cero y los negativos — "volver dentro de cero meses" no significa nada', () => {
    expect(parseJobCaptureResponse('{"kind":"job","nextServiceMonths":0}')?.nextServiceMonths).toBeNull();
    expect(parseJobCaptureResponse('{"kind":"job","nextServiceMonths":-6}')?.nextServiceMonths).toBeNull();
  });

  it('descarta un disparate: un recordatorio para el año 2126 no lo corrige nadie porque nadie lo ve', () => {
    expect(parseJobCaptureResponse('{"kind":"job","nextServiceMonths":1200}')?.nextServiceMonths).toBeNull();
  });

  it('acepta el tope exacto de diez años', () => {
    expect(parseJobCaptureResponse('{"kind":"job","nextServiceMonths":120}')?.nextServiceMonths).toBe(120);
  });
});

describe('parseJobCaptureResponse — el equipo', () => {
  it('extrae marca, modelo y año', () => {
    const parsed = parseJobCaptureResponse(
      '{"kind":"job","equipment":{"brand":"Vaillant","model":"ecoTEC","installedYear":2019}}',
    );
    expect(parsed?.equipment).toEqual({ brand: 'Vaillant', model: 'ecoTEC', installedYear: 2019 });
  });

  it('un equipo con los tres campos vacíos es ruido, no un equipo', () => {
    const parsed = parseJobCaptureResponse(
      '{"kind":"job","equipment":{"brand":null,"model":null,"installedYear":null}}',
    );
    expect(parsed?.equipment).toBeNull();
  });

  it('descarta un año imposible pero conserva el resto del equipo', () => {
    const parsed = parseJobCaptureResponse('{"kind":"job","equipment":{"brand":"Vaillant","installedYear":19}}');
    expect(parsed?.equipment).toEqual({ brand: 'Vaillant', model: null, installedYear: null });
  });

  it('no revienta si el equipo viene como array o como texto', () => {
    expect(parseJobCaptureResponse('{"kind":"job","equipment":[]}')?.equipment).toBeNull();
    expect(parseJobCaptureResponse('{"kind":"job","equipment":"una caldera"}')?.equipment).toBeNull();
  });
});

// La regla nº1 de la cabecera: el modelo no hace aritmética de fechas.
describe('nextServiceDate', () => {
  it('suma los meses sobre la fecha del trabajo, que es un dato que ya tenemos', () => {
    const done = new Date('2026-09-15T10:00:00Z');
    expect(nextServiceDate(done, 12)?.toISOString().slice(0, 10)).toBe('2027-09-15');
    expect(nextServiceDate(done, 6)?.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('sin meses no hay fecha: un trabajo sin revisión pendiente no dispara nada', () => {
    expect(nextServiceDate(new Date('2026-09-15T10:00:00Z'), null)).toBeNull();
  });

  it('el 31 de enero + 1 mes cae en marzo, no en un 31 de febrero que no existe', () => {
    const due = nextServiceDate(new Date('2026-01-31T10:00:00Z'), 1);
    expect(due?.getUTCMonth()).toBe(2); // marzo
  });

  it('cruza el año sin ayuda', () => {
    const due = nextServiceDate(new Date('2026-11-20T10:00:00Z'), 4);
    expect(due?.toISOString().slice(0, 7)).toBe('2027-03');
  });
});
