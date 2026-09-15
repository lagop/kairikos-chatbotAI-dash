// =============================================================================
// Fase 3 — tests de las plantillas de recuperación.
//
// La categoría es lo que más importa aquí y lo que menos se nota si está
// mal: una plantilla declarada UTILITY que en realidad es marketing pasa
// la revisión de Meta la primera vez, se cobra más barata, y degrada la
// cuenta entera cuando Meta lo detecta. Es un error que tarda meses en
// aparecer, así que conviene que lo vigile un test.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  RECOVERY_TEMPLATES,
  RECOVERY_TEMPLATE_DEFINITIONS,
  greetingParam,
  buildRecoveryParams,
} from '@/lib/recovery-templates';
import { LEGAL_NOTICE_TEXT } from '@/lib/recall-optout';

describe('las categorías', () => {
  it('el seguimiento de un presupuesto concreto es UTILITY: hay una transacción identificable detrás', () => {
    expect(RECOVERY_TEMPLATES.open_quote.category).toBe('UTILITY');
  });

  it('el recordatorio de una revisión es UTILITY: es un equipo que instalamos, con su fecha', () => {
    expect(RECOVERY_TEMPLATES.service_anniversary.category).toBe('UTILITY');
  });

  // El test que de verdad importa de este fichero.
  it('el reenganche de un cliente dormido es MARKETING, y no hay forma honesta de defender otra cosa', () => {
    expect(RECOVERY_TEMPLATES.dormant.category).toBe('MARKETING');
  });
});

describe('el aviso de oposición', () => {
  it('va en LAS TRES: el marco exige la salida en cada mensaje, no solo en el primero', () => {
    for (const def of RECOVERY_TEMPLATE_DEFINITIONS) {
      expect(def.bodyText, `${def.name} se ha quedado sin aviso`).toContain(LEGAL_NOTICE_TEXT);
    }
  });

  it('se importa, no se reescribe: la redacción legal vive en un solo sitio con su versión', () => {
    // Si alguien copiara el texto a mano y luego cambiara el original,
    // estas tres plantillas seguirían prometiendo una salida con otra
    // palabra que el detector de bajas ya no reconocería.
    expect(RECOVERY_TEMPLATES.dormant.bodyText.endsWith(LEGAL_NOTICE_TEXT)).toBe(true);
  });
});

describe('la forma de las plantillas', () => {
  it('ninguna termina en {{n}} — la regla de Meta con la que ya chocamos dos veces (2388299)', () => {
    for (const def of RECOVERY_TEMPLATE_DEFINITIONS) {
      expect(def.bodyText.trim().endsWith('}}')).toBe(false);
    }
  });

  it('cada {{n}} único tiene su ejemplo, que Meta exige para revisarla', () => {
    for (const def of RECOVERY_TEMPLATE_DEFINITIONS) {
      const unique = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.bodyExamples, def.name).toHaveLength(unique.size);
    }
  });

  it('el orden de parámetros documentado casa con los {{n}} del cuerpo', () => {
    for (const def of RECOVERY_TEMPLATE_DEFINITIONS) {
      const unique = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.paramOrder, def.name).toHaveLength(unique.size);
    }
  });

  it('todas en español', () => {
    for (const def of RECOVERY_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
    }
  });
});

describe('greetingParam', () => {
  it('usa el nombre de pila, no el apellido: un apellido suena a carta del banco', () => {
    expect(greetingParam('García Pérez')).toBe(' García');
  });

  // El espacio va DENTRO del parámetro, no en la plantilla. Si estuviera
  // en la plantilla ("Hola {{1}},"), un contacto sin nombre dejaría
  // "Hola , te escribimos" — y Meta además rechaza un parámetro vacío.
  it('sin nombre devuelve cadena vacía, y el mensaje se lee bien igual', () => {
    expect(greetingParam(null)).toBe('');
    expect(greetingParam('   ')).toBe('');
  });

  it('el espacio va incorporado cuando sí hay nombre', () => {
    expect(greetingParam('García').startsWith(' ')).toBe(true);
  });
});

describe('buildRecoveryParams', () => {
  it('dos parámetros para presupuesto abierto', () => {
    expect(
      buildRecoveryParams('open_quote', { contactName: 'García', businessName: 'Fontanería Aurora' }),
    ).toEqual([' García', 'Fontanería Aurora']);
  });

  it('tres para la revisión, con el vencimiento', () => {
    expect(
      buildRecoveryParams('service_anniversary', {
        contactName: 'García',
        businessName: 'Fontanería Aurora',
        dueDescription: 'este mes',
      }),
    ).toEqual([' García', 'Fontanería Aurora', 'este mes']);
  });

  it('nunca manda un parámetro en blanco — Meta rechaza el envío entero', () => {
    const params = buildRecoveryParams('service_anniversary', {
      contactName: null,
      businessName: 'Fontanería Aurora',
      dueDescription: '   ',
    });
    // El saludo SÍ puede ir vacío (el espacio está dentro), pero el
    // vencimiento no: ese va en mitad de la frase.
    expect(params[2]).toBe('próximamente');
  });
});
