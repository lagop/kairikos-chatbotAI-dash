// =============================================================================
// A3 — unit tests de la secuencia de bienvenida.
//
// El plan la describía como "secuencia de la prueba gratis", pero no hay
// pruebas gratis en el producto: esto es lo mismo aplicado a lo que sí pasa,
// los catorce días en los que un cliente recién contratado o consigue su
// primer resultado o se olvida.
//
// Lo que se fija:
//
// 1. Que cada paso se mande UNA vez y en su día, ni antes ni dos veces.
// 2. Que a quien ya lo tiene funcionando NO se le pregunte si ya lo ha
//    configurado. Es el correo que más molesta de toda la secuencia.
// 3. Que un paso que no aplica se selle igual, o se reintentaría para
//    siempre en cada tick.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { nextDripStep, buildDripEmail, isTooOldForDrip, DRIP_STEPS } from '@/lib/client-onboarding-drip';

const ALTA = new Date('2026-09-01T10:00:00Z');
const dias = (n: number) => new Date(ALTA.getTime() + n * 24 * 60 * 60 * 1000);

describe('nextDripStep', () => {
  it('el día del alta toca la bienvenida', () => {
    expect(nextDripStep(ALTA, 0, ALTA)?.key).toBe('bienvenida');
  });

  it('el segundo paso no se adelanta al primer día', () => {
    expect(nextDripStep(ALTA, 1, dias(0.5))).toBeNull();
    expect(nextDripStep(ALTA, 1, dias(1))?.key).toBe('recordatorio_activacion');
  });

  it('con la secuencia terminada no vuelve a empezar', () => {
    expect(nextDripStep(ALTA, DRIP_STEPS.length, dias(90))).toBeNull();
  });

  it('un barrido parado una semana no manda los cuatro de golpe: va uno por tick', () => {
    expect(nextDripStep(ALTA, 0, dias(20))?.key).toBe('bienvenida');
    expect(nextDripStep(ALTA, 1, dias(20))?.key).toBe('recordatorio_activacion');
  });
});

describe('buildDripEmail', () => {
  const base = { businessName: 'Fontanería Ejemplo', productCode: 'recall', yaTieneResultados: false };

  it('la bienvenida dice qué hacer ahora, no da la enhorabuena', () => {
    const email = buildDripEmail(DRIP_STEPS[0], base)!;
    expect(email.text).toContain('termina la configuración');
  });

  it('a quien ya lo tiene funcionando NO se le pregunta si lo ha configurado', () => {
    expect(buildDripEmail(DRIP_STEPS[1], { ...base, yaTieneResultados: true })).toBeNull();
  });

  it('a quien no, se le ofrece ayuda sin reprochar nada', () => {
    const email = buildDripEmail(DRIP_STEPS[1], base)!;
    expect(email.text).toContain('No es un reproche');
  });

  it('el tercer correo cambia entero según si funciona o no', () => {
    const funcionando = buildDripEmail(DRIP_STEPS[2], { ...base, yaTieneResultados: true })!;
    const parado = buildDripEmail(DRIP_STEPS[2], base)!;
    expect(funcionando.subject).toContain('funcionando');
    expect(parado.subject).toContain('Sigue sin estar en marcha');
  });

  it('el de las dos semanas pide una respuesta, que es para lo que sirve', () => {
    const email = buildDripEmail(DRIP_STEPS[3], base)!;
    expect(email.text).toContain('Respóndeme');
  });

  it('el nombre del negocio aparece en todos', () => {
    for (const step of DRIP_STEPS) {
      const email = buildDripEmail(step, { ...base, yaTieneResultados: false });
      if (email) expect(email.text).toContain('Fontanería Ejemplo');
    }
  });
});

// =============================================================================
// 24/09/2026 — encontrado al desplegar: los clientes activados hacía semanas
// entraban en la secuencia desde el paso cero, como si acabaran de contratar.
// Un correo de bienvenida con tres semanas de retraso no da la bienvenida a
// nada: delata que acabamos de encender algo.
// =============================================================================
describe('altas demasiado viejas', () => {
  it('pasado el plazo no se manda nada', () => {
    expect(nextDripStep(ALTA, 0, dias(30))).toBeNull();
  });

  it('y se reconocen para poder cerrarlas de una vez', () => {
    expect(isTooOldForDrip(ALTA, dias(30))).toBe(true);
    expect(isTooOldForDrip(ALTA, dias(5))).toBe(false);
  });

  it('dentro del plazo la secuencia sigue funcionando', () => {
    expect(nextDripStep(ALTA, 3, dias(15))?.key).toBe('primer_mes');
  });
});
