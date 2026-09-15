// =============================================================================
// Fase 4 — tests del importador.
//
// Casi todo el peso está en dos parseos que fallan SIN DAR ERROR, que es
// lo que los hace peligrosos:
//
//   · El importe. "1.400,50 €" leído a la americana son 1,40 €. El número
//     sigue pareciendo un número, la importación termina en verde, y la
//     base de 61.000 € aparece como 61 €. Nadie lo mira dos veces.
//
//   · La fecha. new Date("03/04/2026") es el 4 de marzo para JavaScript y
//     el 3 de abril en un export español. Un mes de desfase en la fecha
//     del último servicio desplaza TODOS los recordatorios de revisión.
//
// Y una tercera cosa que no es un parseo: que la base legal existente
// nunca se pise con una importación.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  parseAmount,
  parseImportDate,
  looksLikeEmail,
  guessColumnMapping,
  computeQualityScore,
  analyseImport,
  describeDiagnostic,
  commitImport,
  IMPORT_DECLARATION_V1,
} from '@/lib/contact-import';
import { parseCsvRows, parseCsvTable, detectDelimiter } from '@/lib/csv';

const NOW = new Date('2026-09-15T12:00:00Z');

describe('parseCsvRows — los tres casos de un export real', () => {
  it('respeta las comas dentro de comillas: "García, S.L." es UN campo', () => {
    expect(parseCsvRows('a,"García, S.L.",c')).toEqual([['a', 'García, S.L.', 'c']]);
  });

  it('entiende las comillas escapadas duplicándolas', () => {
    expect(parseCsvRows('a,"El ""Pepe""",c')).toEqual([['a', 'El "Pepe"', 'c']]);
  });

  // El que rompe a todo el que parte por \n antes de parsear.
  it('respeta los saltos de línea DENTRO de un campo entrecomillado', () => {
    const csv = 'nombre,direccion\nGarcía,"Calle Mayor 14\n3º B"';
    expect(parseCsvRows(csv)).toEqual([
      ['nombre', 'direccion'],
      ['García', 'Calle Mayor 14\n3º B'],
    ]);
  });

  it('quita el BOM que escribe Excel, que si no deja la primera cabecera sin casar', () => {
    const table = parseCsvTable('﻿nombre,telefono\nGarcía,651234567');
    expect(table.headers[0]).toBe('nombre');
  });

  it('aguanta CRLF y la última línea sin salto', () => {
    expect(parseCsvRows('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('no convierte las líneas en blanco del final en filas vacías', () => {
    expect(parseCsvRows('a,b\nc,d\n\n\n')).toHaveLength(2);
  });
});

describe('detectDelimiter', () => {
  it('detecta el punto y coma, que es lo que saca Excel en español', () => {
    expect(detectDelimiter('nombre;telefono;importe')).toBe(';');
  });

  it('no se deja engañar por separadores dentro de comillas', () => {
    // A lo bruto habría 2 punto y coma contra 1 coma, y elegiría mal.
    expect(detectDelimiter('"Apellidos; Nombre","Tel; fijo",importe')).toBe(',');
  });
});

describe('parseAmount — el error que convierte 61.000 € en 61 €', () => {
  it('lee el formato español', () => {
    expect(parseAmount('1.400,50 €')).toBe(1400.5);
    expect(parseAmount('61.000')).toBe(61000);
    expect(parseAmount('340,00')).toBe(340);
  });

  it('lee también el formato inglés, porque algunos programas exportan así', () => {
    expect(parseAmount('1,400.50')).toBe(1400.5);
  });

  it('un punto con tres cifras detrás son miles, no decimales', () => {
    expect(parseAmount('1.400')).toBe(1400);
  });

  it('un punto con otras cifras detrás sí es decimal', () => {
    expect(parseAmount('1.4')).toBe(1.4);
    expect(parseAmount('1.45')).toBe(1.45);
  });

  it('ignora el símbolo, los espacios y lo que no sea número', () => {
    expect(parseAmount('  340 EUR ')).toBe(340);
  });

  it('devuelve null en vez de cero cuando no hay importe: son cosas distintas', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/d')).toBeNull();
  });
});

describe('parseImportDate — el error que desplaza todos los recordatorios', () => {
  it('lee DD/MM/AAAA, no MM/DD/AAAA', () => {
    const d = parseImportDate('03/04/2026');
    // 3 de abril, no 4 de marzo.
    expect(d?.toISOString().slice(0, 10)).toBe('2026-04-03');
  });

  it('corrige el formato americano cuando es inequívoco', () => {
    // 25 no puede ser un mes: esto era MM/DD.
    expect(parseImportDate('04/25/2026')?.toISOString().slice(0, 10)).toBe('2026-04-25');
  });

  it('acepta guiones y puntos como separador', () => {
    expect(parseImportDate('03-04-2026')?.toISOString().slice(0, 10)).toBe('2026-04-03');
    expect(parseImportDate('03.04.2026')?.toISOString().slice(0, 10)).toBe('2026-04-03');
  });

  it('expande el año de dos cifras', () => {
    expect(parseImportDate('03/04/26')?.getUTCFullYear()).toBe(2026);
  });

  it('acepta ISO', () => {
    expect(parseImportDate('2026-04-03')?.toISOString().slice(0, 10)).toBe('2026-04-03');
  });

  it('rechaza lo que no es una fecha', () => {
    expect(parseImportDate('')).toBeNull();
    expect(parseImportDate('pendiente')).toBeNull();
    expect(parseImportDate('45/13/2026')).toBeNull();
  });
});

describe('guessColumnMapping', () => {
  it('prefiere el móvil al fijo cuando el export trae los dos', () => {
    // El fijo casi nunca tiene WhatsApp.
    const mapping = guessColumnMapping(['nombre', 'telefono', 'telefono_movil']);
    expect(mapping.phone).toBe('telefono_movil');
  });

  it('reconoce las cabeceras con acentos y mayúsculas', () => {
    const mapping = guessColumnMapping(['Teléfono', 'Nombre', 'Importe']);
    expect(mapping).toMatchObject({ phone: 'telefono', name: 'nombre', amount: 'importe' });
  });

  it('no asigna la misma columna a dos campos', () => {
    const mapping = guessColumnMapping(['cliente', 'total']);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('computeQualityScore', () => {
  const base = {
    totalRows: 100,
    withValidPhone: 100,
    withName: 100,
    withValidEmail: 0,
    withDate: 100,
    withAmount: 100,
    duplicatesInFile: 0,
  };

  it('una base perfecta saca 100', () => {
    expect(computeQualityScore(base)).toBe(100);
  });

  // El teléfono pesa la mitad porque sin él el contacto no se puede
  // recuperar por ningún canal de este producto.
  it('sin teléfonos no pasa de 50 por muy bonito que sea el resto', () => {
    expect(computeQualityScore({ ...base, withValidPhone: 0 })).toBe(50);
  });

  it('un fichero vacío saca 0 sin dividir por cero', () => {
    expect(computeQualityScore({ ...base, totalRows: 0 })).toBe(0);
  });
});

describe('analyseImport — la herramienta de venta', () => {
  const CSV = [
    'Nombre;Teléfono;Fecha;Concepto;Importe;Próxima revisión',
    'García Pérez;651234567;03/04/2023;Cambio de termo;1.400,50;03/04/2024',
    'Martínez;622334455;10/06/2026;Revisión caldera;120,00;10/06/2027',
    'Sin teléfono;;01/01/2026;Reparación;80,00;',
    'García Pérez;651 23 45 67;15/09/2024;Reparación fuga;95,00;',
  ].join('\n');

  it('no escribe nada: es una función pura sobre el fichero', () => {
    // Su firma no recibe prisma. Si algún día lo recibiera, dejaría de
    // poder ejecutarse sobre el fichero de un prospecto sin contrato.
    expect(analyseImport.length).toBeLessThanOrEqual(2);
  });

  it('deduplica por teléfono normalizado dentro del propio fichero', () => {
    const a = analyseImport(CSV, { now: NOW });
    // '651234567' y '651 23 45 67' son la misma persona.
    expect(a.quality.duplicatesInFile).toBe(1);
    expect(a.diagnostic.usableContacts).toBe(2);
  });

  it('cuenta los dormidos sobre CONTACTOS, no sobre filas', () => {
    const a = analyseImport(CSV, { now: NOW });
    // García tiene dos facturas; su última es de septiembre de 2024, hace
    // menos de 18 meses respecto a… no: hace 24. Está dormido, y cuenta
    // UNA vez aunque tenga dos filas.
    expect(a.diagnostic.dormantContacts).toBe(1);
  });

  it('suma el importe leyendo el formato español', () => {
    const a = analyseImport(CSV, { now: NOW });
    // 1400,50 + 120 + 95 = 1615,50. Si leyera "1.400,50" a la americana
    // saldrían 216 y nadie lo notaría, porque sigue pareciendo un número.
    expect(a.diagnostic.totalBilled).toBeCloseTo(1615.5, 2);
  });

  // La dirección del error importa: en un número que se enseña en una
  // llamada de venta, contar dinero de contactos inalcanzables es
  // sobrevender. Se queda fuera a propósito.
  it('NO cuenta el dinero de las filas sin teléfono: ese histórico no se puede trabajar', () => {
    const a = analyseImport(CSV, { now: NOW });
    // La fila "Sin teléfono" trae 80 € que no entran en el total.
    expect(a.diagnostic.totalBilled).toBeLessThan(1695.5);
  });

  it('marca las filas sin teléfono en vez de inventarles uno', () => {
    const a = analyseImport(CSV, { now: NOW });
    expect(a.rows.filter((r) => r.skipReason === 'no_phone')).toHaveLength(1);
  });

  it('detecta revisiones ya vencidas', () => {
    const a = analyseImport(CSV, { now: NOW });
    // La de García vencía en 2024.
    expect(a.diagnostic.overdueServices).toBe(1);
  });

  it('devuelve una vista previa para que una persona confirme el mapeo', () => {
    const a = analyseImport(CSV, { now: NOW });
    expect(a.preview.length).toBeGreaterThan(0);
    expect(a.preview.length).toBeLessThanOrEqual(5);
  });

  it('aguanta un fichero vacío sin reventar', () => {
    const a = analyseImport('', { now: NOW });
    expect(a.quality.totalRows).toBe(0);
    expect(a.quality.score).toBe(0);
  });
});

describe('describeDiagnostic', () => {
  it('le enseña sus propios números, sin prometer nada', () => {
    const a = analyseImport(
      'Nombre;Teléfono;Fecha;Importe\nGarcía;651234567;03/04/2022;1.400,50',
      { now: NOW },
    );
    const text = describeDiagnostic(a);
    expect(text).toContain('1 clientes con teléfono utilizable');
    expect(text).toContain('Calidad de los datos:');
    // Ni una promesa de resultado.
    expect(text).not.toMatch(/garantiz|conseguir|recuperar[eá]/i);
  });
});

// ---------------------------------------------------------------------------

const state = {
  importCreate: vi.fn(),
  importUpdate: vi.fn(),
  contactFindUnique: vi.fn(),
  contactCreate: vi.fn(),
  contactUpdate: vi.fn(),
  jobFindFirst: vi.fn(),
  jobCreate: vi.fn(),
};

const prisma = {
  contactImport: {
    create: (...a: unknown[]) => state.importCreate(...a),
    update: (...a: unknown[]) => state.importUpdate(...a),
  },
  contact: {
    findUnique: (...a: unknown[]) => state.contactFindUnique(...a),
    create: (...a: unknown[]) => state.contactCreate(...a),
    update: (...a: unknown[]) => state.contactUpdate(...a),
  },
  job: {
    findFirst: (...a: unknown[]) => state.jobFindFirst(...a),
    create: (...a: unknown[]) => state.jobCreate(...a),
  },
} as unknown as PrismaClient;

const SIMPLE_CSV = 'Nombre;Teléfono;Fecha;Importe\nGarcía;651234567;03/04/2023;340,00';

const COMMIT = {
  clientId: 'client_1',
  tenantId: 'tenant_1',
  csvText: SIMPLE_CSV,
  legalDeclaration: IMPORT_DECLARATION_V1,
  declaredBy: 'operador@kairikos.com',
  now: NOW,
};

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.importCreate.mockResolvedValue({ id: 'imp_1' });
  state.importUpdate.mockResolvedValue({});
  state.contactFindUnique.mockResolvedValue(null);
  state.contactCreate.mockResolvedValue({ id: 'contact_1' });
  state.contactUpdate.mockResolvedValue({});
  state.jobFindFirst.mockResolvedValue(null);
  state.jobCreate.mockResolvedValue({ id: 'job_1' });
});

describe('commitImport', () => {
  // La precondición. Es de las pocas cosas de este repo que lanzan, y a
  // propósito: no es un caso degradado, es que sin declaración no se
  // puede importar nada con base legal.
  it('SE NIEGA a importar sin declaración de origen, y no escribe nada', async () => {
    await expect(commitImport(prisma, { ...COMMIT, legalDeclaration: '   ' })).rejects.toThrow(
      'import_requires_legal_declaration',
    );
    expect(state.importCreate).not.toHaveBeenCalled();
    expect(state.contactCreate).not.toHaveBeenCalled();
  });

  it('guarda la declaración LITERAL, no un booleano', async () => {
    await commitImport(prisma, COMMIT);
    expect(state.importCreate.mock.calls[0][0].data).toMatchObject({
      legalDeclaration: IMPORT_DECLARATION_V1,
      declaredBy: 'operador@kairikos.com',
    });
  });

  it('crea el contacto con base legal declarada y el puntero a la importación', async () => {
    await commitImport(prisma, COMMIT);
    expect(state.contactCreate.mock.calls[0][0].data).toMatchObject({
      e164: '+34651234567',
      source: 'import',
      legalBasis: 'import_declared',
      legalBasisEvidenceId: 'imp_1',
    });
  });

  // La regla que impide que una importación "mejore" la base legal de
  // alguien que ya la tenía de otro sitio.
  it('NUNCA pisa la base legal de un contacto que ya la tenía', async () => {
    state.contactFindUnique.mockResolvedValue({
      id: 'contact_1',
      legalBasis: 'inbound_contact',
      name: 'García',
      email: null,
      lastInteractionAt: new Date('2026-01-01T00:00:00Z'),
    });

    await commitImport(prisma, COMMIT);

    const data = state.contactUpdate.mock.calls[0][0].data;
    expect(data.legalBasis).toBeUndefined();
    expect(data.legalBasisEvidenceId).toBeUndefined();
  });

  it('SÍ rellena la base legal de un contacto que no tenía ninguna (los del backfill)', async () => {
    state.contactFindUnique.mockResolvedValue({
      id: 'contact_1',
      legalBasis: null,
      name: null,
      email: null,
      lastInteractionAt: new Date('2020-01-01T00:00:00Z'),
    });

    await commitImport(prisma, COMMIT);
    expect(state.contactUpdate.mock.calls[0][0].data).toMatchObject({
      legalBasis: 'import_declared',
      legalBasisEvidenceId: 'imp_1',
    });
  });

  it('rellena huecos pero no pisa el nombre que ya había — una conversación real vale más que un export viejo', async () => {
    state.contactFindUnique.mockResolvedValue({
      id: 'contact_1',
      legalBasis: 'inbound_contact',
      name: 'García (el de la caldera)',
      email: null,
      lastInteractionAt: new Date('2026-01-01T00:00:00Z'),
    });
    await commitImport(prisma, COMMIT);
    expect(state.contactUpdate.mock.calls[0][0].data.name).toBe('García (el de la caldera)');
  });

  it('crea un Job por fila con fecha', async () => {
    await commitImport(prisma, COMMIT);
    expect(state.jobCreate.mock.calls[0][0].data).toMatchObject({
      contactId: 'contact_1',
      amount: 340,
      captureMethod: 'import',
    });
  });

  it('reimportar el mismo fichero NO duplica el histórico', async () => {
    state.jobFindFirst.mockResolvedValue({ id: 'job_existente' });
    const result = await commitImport(prisma, COMMIT);
    expect(state.jobCreate).not.toHaveBeenCalled();
    expect(result.jobsCreated).toBe(0);
  });

  it('salta las filas sin teléfono y lo cuenta, en vez de inventarse un contacto', async () => {
    const result = await commitImport(prisma, {
      ...COMMIT,
      csvText: 'Nombre;Teléfono;Fecha;Importe\nSin tel;;03/04/2023;340,00',
    });
    expect(result.rowsSkipped).toBe(1);
    expect(state.contactCreate).not.toHaveBeenCalled();
  });

  it('no crea Job cuando la fila no trae fecha: no hay dónde ponerlo en la línea del tiempo', async () => {
    await commitImport(prisma, {
      ...COMMIT,
      csvText: 'Nombre;Teléfono;Importe\nGarcía;651234567;340,00',
    });
    expect(state.jobCreate).not.toHaveBeenCalled();
  });

  it('congela la puntuación de calidad en el registro', async () => {
    await commitImport(prisma, COMMIT);
    expect(state.importCreate.mock.calls[0][0].data.qualitySnapshot).toMatchObject({
      totalRows: 1,
      withValidPhone: 1,
    });
  });
});

describe('looksLikeEmail', () => {
  it('acepta lo normal y rechaza lo que claramente no lo es', () => {
    expect(looksLikeEmail('garcia@example.com')).toBe(true);
    expect(looksLikeEmail('no tengo')).toBe(false);
    expect(looksLikeEmail('garcia@')).toBe(false);
  });
});
