// =============================================================================
// El primer mensaje de Prospección (prospecting_first_contact_v2) y la frase
// con la que el cliente se presenta en él — lib/prospecting-presentacion.ts.
//
// Lo que se fija aquí son las reglas de Meta que no avisan al revisar la
// plantilla sino al ENVIAR, mensaje a mensaje, y que la vista previa del
// portal dice exactamente lo mismo que el envío.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  MAX_CONTACTOS_POR_DIA,
  nombreRemitente,
  normalizarPresentacion,
  PRESENTACION_MAX,
  PRIMER_CONTACTO_TEXTO,
  primerMensaje,
  rellenarPlantilla,
  SEGUIMIENTOS,
} from '@/lib/prospecting-presentacion';
import { PROSPECTING_TEMPLATE_DEFINITIONS } from '@/lib/prospecting-templates';
import { MAX_AUTO_CONTACTS_PER_DAY, PROSPECTING_SEQUENCE } from '@/lib/prospecting-contact';

const variables = (texto: string) => [...new Set(texto.match(/\{\{\d+\}\}/g) ?? [])];

describe('el texto de prospecting_first_contact_v2', () => {
  it('no empieza ni termina en una variable (Meta, error_subcode 2388299)', () => {
    expect(PRIMER_CONTACTO_TEXTO.trim().startsWith('{{')).toBe(false);
    expect(PRIMER_CONTACTO_TEXTO.trim().endsWith('}}')).toBe(false);
  });

  // 2388293: demasiadas variables para el largo del texto. Meta no publica
  // el umbral; recall-templates.ts lo sufrió con menos de ~3 palabras fijas
  // por variable. Con margen.
  it('lleva bastantes palabras fijas por variable (Meta, error_subcode 2388293)', () => {
    const fijas = PRIMER_CONTACTO_TEXTO.replace(/\{\{\d+\}\}/g, ' ').split(/\s+/).filter(Boolean);
    expect(fijas.length / variables(PRIMER_CONTACTO_TEXTO).length).toBeGreaterThanOrEqual(5);
  });

  it('tiene exactamente {{1}}, {{2}} y {{3}}, en orden', () => {
    expect(variables(PRIMER_CONTACTO_TEXTO)).toEqual(['{{1}}', '{{2}}', '{{3}}']);
  });

  it('es el MISMO texto que se somete a Meta, no una copia', () => {
    const def = PROSPECTING_TEMPLATE_DEFINITIONS.find((t) => t.name === 'prospecting_first_contact_v2');
    expect(def?.bodyText).toBe(PRIMER_CONTACTO_TEXTO);
    expect(def?.bodyExamples).toHaveLength(3);
  });

  it('no promete nada por el cliente: la v1 hablaba como una agencia de marketing', () => {
    expect(PRIMER_CONTACTO_TEXTO).not.toMatch(/más clientes|ayudarte a conseguir/i);
  });
});

describe('los seguimientos compartidos', () => {
  it('son los textos que se someten a Meta', () => {
    const sometidos = PROSPECTING_TEMPLATE_DEFINITIONS.filter((t) => t.name.startsWith('prospecting_follow_up_'));
    expect(sometidos.map((t) => t.bodyText)).toEqual(SEGUIMIENTOS.map((s) => s.texto));
  });

  it('son las esperas con las que envía la secuencia', () => {
    expect(PROSPECTING_SEQUENCE.slice(1).map((s) => s.delayDays)).toEqual(SEGUIMIENTOS.map((s) => s.diasDespues));
  });

  it('el tope que cita el consentimiento es el tope con el que se envía', () => {
    expect(MAX_AUTO_CONTACTS_PER_DAY).toBe(MAX_CONTACTOS_POR_DIA);
  });
});

// Un parámetro de más o de menos no lo rechaza Meta al revisar la plantilla:
// lo rechaza al enviar (132000). El envío arma 3 parámetros para el primer
// toque y 2 para los seguimientos; esto comprueba que es lo que pide el texto
// de cada escalón.
describe('parámetros por escalón', () => {
  it('cada escalón de la secuencia pide tantos parámetros como arma el envío', () => {
    const porEscalon = new Map(PROSPECTING_TEMPLATE_DEFINITIONS.map((d) => [d.name, variables(d.bodyText).length]));
    expect(PROSPECTING_SEQUENCE.map((s) => porEscalon.get(s.template.name))).toEqual([3, 2, 2]);
  });
});

describe('normalizarPresentacion', () => {
  it.each([
    ['reformas de baños y cocinas para comunidades', 'reformas de baños y cocinas para comunidades'],
    // El campo ya va precedido de «Nos dedicamos a».
    ['Nos dedicamos a las reformas de baños', 'las reformas de baños'],
    ['nos dedicamos al mantenimiento de edificios', 'mantenimiento de edificios'],
    ['Nos  dedicamos   a reformas', 'reformas'],
    // «a el» no es español.
    ['el mantenimiento de edificios', 'mantenimiento de edificios'],
    // Detrás va «y creemos que…».
    ['reformas de baños.', 'reformas de baños'],
    ['reformas de baños!!! ', 'reformas de baños'],
    // Meta rechaza al enviar un parámetro con saltos de línea, tabuladores o
    // más de cuatro espacios seguidos.
    ['reformas\nde baños\t y   cocinas', 'reformas de baños y cocinas'],
    // «al» se quita solo si es la palabra entera.
    ['alquileres de temporada', 'alquileres de temporada'],
    ['las reformas', 'las reformas'],
  ])('%j → %j', (entrada, salida) => {
    expect(normalizarPresentacion(entrada)).toBe(salida);
  });

  it.each([null, undefined, '', '   ', '...', 'Nos dedicamos a', 'Nos dedicamos a.', 'nos dedicamos al '])(
    '%j no deja nada que enviar → null',
    (entrada) => {
      expect(normalizarPresentacion(entrada)).toBeNull();
    },
  );

  it('no recorta: una frase partida en nombre del cliente es peor que pedirle que la acorte', () => {
    const larga = 'x'.repeat(PRESENTACION_MAX + 20);
    expect(normalizarPresentacion(larga)).toBe(larga);
  });
});

describe('primerMensaje', () => {
  it('es la plantilla rellenada, como lo hace Meta', () => {
    expect(
      primerMensaje({ prospecto: 'Fincas Ribera', negocio: 'Reformas Orly', presentacion: 'reformas de baños' }),
    ).toBe(
      'Hola Fincas Ribera, te escribo de Reformas Orly. Nos dedicamos a reformas de baños y creemos que te puede interesar. ¿Te cuento en dos líneas, sin compromiso?',
    );
  });

  it('rellenarPlantilla deja a la vista una variable sin parámetro, en vez de un hueco', () => {
    expect(rellenarPlantilla('Hola {{1}}, somos {{2}}.', ['Ana'])).toBe('Hola Ana, somos {{2}}.');
  });
});

describe('nombreRemitente', () => {
  it('prefiere el nombre comercial', () => {
    expect(nombreRemitente({ name: 'Aurora', companyName: 'Peluquería Aurora' })).toBe('Peluquería Aurora');
  });

  // CLAUDE.md, trampa 4: con `??`, un companyName vacío ganaba.
  it.each(['', '   ', null])('un nombre comercial %j cae al nombre', (companyName) => {
    expect(nombreRemitente({ name: ' Aurora ', companyName })).toBe('Aurora');
  });

  it('sin cliente, vacío', () => {
    expect(nombreRemitente(null)).toBe('');
  });
});
