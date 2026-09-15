// =============================================================================
// Fase 4 — lectura de CSV.
//
// La mitad de escritura ya existía (buildCsv / escapeCsvValue en
// lead-export.ts). Esta es la de lectura, y vive aparte porque no comparte
// nada con aquella salvo el formato: escribir CSV es trivial, leerlo tiene
// tres casos raros que hay que acertar o los datos entran mal en silencio.
//
// SIN DEPENDENCIA NUEVA, y no por ahorrar: un parser de CSV son cuarenta
// líneas de máquina de estados que se pueden leer enteras, y lo que entra
// aquí es el export de contabilidad de un cliente — un fichero del que
// conviene saber exactamente cómo se interpreta, no delegarlo en las
// opciones por defecto de una librería.
//
// LOS TRES CASOS QUE IMPORTAN, todos vistos en exports reales de programas
// de facturación:
//
//   1. Comas dentro de comillas: "García, S.L." es UN campo.
//   2. Comillas escapadas duplicándolas: "El ""Pepe""" es: El "Pepe".
//   3. Saltos de línea DENTRO de un campo entrecomillado — una dirección
//      con dos líneas. Partir por \n antes de parsear, que es lo que hace
//      todo el mundo la primera vez, rompe el fichero justo ahí.
//
// Se detecta el separador además de la coma: los exports españoles salen a
// menudo con punto y coma, porque Excel en configuración regional española
// usa la coma como decimal.
// =============================================================================

/** Quita el BOM que Excel escribe al principio de sus CSV en UTF-8. Sin
 *  esto, la primera cabecera se llama "﻿nombre" y no casa con nada. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Adivina el separador mirando la primera línea.
 *
 * Se cuenta FUERA de las comillas: un fichero separado por comas cuya
 * primera cabecera sea "Apellidos; Nombre" tiene más punto y coma que
 * comas si se cuenta a lo bruto, y se elegiría el separador equivocado
 * para todo el fichero.
 */
export function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === ',' || char === ';' || char === '\t')) counts[char] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/**
 * Convierte un CSV en filas de celdas.
 *
 * Máquina de estados carácter a carácter — no hay atajo con split() que
 * respete los tres casos de la cabecera.
 */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const clean = stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!clean.trim()) return [];

  const sep = delimiter ?? detectDelimiter(clean.slice(0, clean.indexOf('\n') + 1 || undefined));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        // Comilla doble dentro de comillas: es una comilla literal.
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        // Incluidos los saltos de línea: dentro de comillas son datos.
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // La última fila, que casi nunca termina en salto de línea.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Las líneas en blanco del final de un export no son filas vacías: son
  // nada. Una fila de una sola celda vacía es exactamente eso.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Lo mismo, pero con la primera fila como cabeceras.
 *
 * Las cabeceras se normalizan (minúsculas, sin acentos, sin espacios) para
 * que "Teléfono", "telefono" y "TELEFONO " sean la misma columna. El
 * mapeo automático de arriba depende de eso, y un export real trae las
 * cabeceras escritas como al programa le pareció aquel día.
 */
export function parseCsvTable(text: string, delimiter?: string): CsvTable {
  const raw = parseCsvRows(text, delimiter);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map(normaliseHeader);
  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
}

export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
