// =============================================================================
// Fase 4 — unit tests para src/lib/lead-export.ts.
//
// El escapado es lo único que hay que fijar aquí, y por dos motivos muy
// distintos: una coma sin escapar parte la fila y el cliente abre una hoja
// con las columnas desplazadas; y un campo que empieza por '=' lo ejecuta
// Excel como fórmula. Ese texto lo escribe un desconocido por WhatsApp.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { escapeCsvValue, buildCsv, exportFilename, LEAD_EXPORT_COLUMNS } from '@/lib/lead-export';

describe('escapeCsvValue', () => {
  it('deja en paz lo que no necesita nada', () => {
    expect(escapeCsvValue('Marta')).toBe('Marta');
    expect(escapeCsvValue(42)).toBe('42');
  });

  it('un valor ausente es una celda vacía, no la palabra null', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('entrecomilla cuando hay comas, comillas o saltos', () => {
    expect(escapeCsvValue('Corte, color y mechas')).toBe('"Corte, color y mechas"');
    expect(escapeCsvValue('Dijo "vale"')).toBe('"Dijo ""vale"""');
    expect(escapeCsvValue('linea1\nlinea2')).toBe('"linea1\nlinea2"');
  });

  it('neutraliza las fórmulas de Excel: el texto lo escribe un desconocido', () => {
    // Sin esto, abrir el CSV ejecuta lo que haya puesto quien escribió.
    expect(escapeCsvValue('=1+1')).toBe("'=1+1");
    expect(escapeCsvValue('+34600111222')).toBe("'+34600111222");
    expect(escapeCsvValue('-5')).toBe("'-5");
    expect(escapeCsvValue('@import')).toBe("'@import");
  });

  it('una fórmula CON coma se neutraliza Y se entrecomilla', () => {
    expect(escapeCsvValue('=HYPERLINK("http://x","a")')).toBe('"\'=HYPERLINK(""http://x"",""a"")"');
  });

  it('las fechas salen en ISO, que es lo que sabe leer todo el mundo', () => {
    expect(escapeCsvValue(new Date('2026-09-08T10:00:00.000Z'))).toBe('2026-09-08T10:00:00.000Z');
  });
});

describe('buildCsv', () => {
  it('empieza por la cabecera en castellano', () => {
    const csv = buildCsv([]);
    expect(csv.split('\r\n')[0]).toContain('Nombre,Teléfono,Email');
  });

  it('una fila por lead, en el orden de las columnas', () => {
    const csv = buildCsv([{ contactName: 'Marta', contactPhone: '+34600111222', status: 'nuevo' }]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    // El teléfono lleva '+' delante, así que va neutralizado.
    expect(lines[1]).toContain("'+34600111222");
    expect(lines[1]).toContain('Marta');
  });

  it('un campo que falta deja la celda vacía, no rompe la fila', () => {
    const csv = buildCsv([{ contactName: 'Marta' }]);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells).toHaveLength(LEAD_EXPORT_COLUMNS.length);
  });

  it('termina las filas con CRLF, que es lo que espera Excel', () => {
    expect(buildCsv([{ contactName: 'a' }])).toContain('\r\n');
  });
});

describe('exportFilename', () => {
  it('lleva la fecha dentro, para no acumular cinco leads.csv iguales', () => {
    expect(exportFilename(new Date('2026-09-08T10:00:00Z'))).toBe('leads-kairikos-2026-09-08.csv');
  });
});
