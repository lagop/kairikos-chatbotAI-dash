import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';

// =============================================================================
// Cartera — un ZIP en streaming, sin dependencias (PR 6, la exportación).
//
// Por qué propio: el portal no tiene una librería de ZIP entre sus
// dependencias (fflate solo llega con @vitest/ui, que no va a producción), y
// lo que hace falta es poco: guardar sin comprimir (las fotos ya son JPEG,
// PNG o WebP; los JSON pesan nada) y no cargar todas las fotos en memoria.
//
// Cada foto se lee DOS veces: una para su CRC-32 y otra para copiarla. Así la
// cabecera local lleva ya el CRC y los tamaños y no hacen falta descriptores
// de datos, que algunos lectores no aceptan en entradas sin comprimir. Una
// foto pesa 3 MB como mucho y la segunda lectura sale de la caché del sistema.
//
// ZIP64 solo para el directorio central, cuando el archivo pasa de 4 GB o de
// 65.535 entradas (una agencia de 100 casas son unos 2,4 GB). Ninguna entrada
// pasa de 4 GB por sí sola: las fotos tienen tope de 3 MB.
//
// `zlib.crc32` existe desde Node 20.15 y 22.2; la imagen usa Node 22.
// =============================================================================

export type ZipEntry =
  | { name: string; data: Uint8Array }
  | {
      name: string;
      /** Ruta absoluta del archivo y su tamaño: se comprueba al copiarlo. */
      file: string;
      size: number;
    };

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

async function fileCrc(path: string): Promise<{ crc: number; size: number }> {
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    crc = crc32(chunk as Buffer, crc);
    size += (chunk as Buffer).length;
  }
  return { crc, size };
}

/**
 * Los bytes del ZIP, en trozos. Si un archivo cambia de tamaño entre que se
 * planificó y se copia, lanza: un ZIP con una foto truncada es peor que
 * ninguno, y a esas alturas la respuesta ya ha empezado, así que el navegador
 * verá la descarga cortada.
 */
export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, modified: Date = new Date()): AsyncGenerator<Uint8Array> {
  const { time, date } = dosDateTime(modified);
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    let crc: number;
    let size: number;
    if ('data' in entry) {
      crc = crc32(entry.data);
      size = entry.data.length;
    } else {
      ({ crc, size } = await fileCrc(entry.file));
      if (size !== entry.size) throw new Error(`zip: ${entry.name} ha cambiado de tamaño`);
    }
    if (size > MAX32) throw new Error(`zip: ${entry.name} pasa de 4 GB`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria: 2.0
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(0, 8); // sin comprimir
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield name;

    if ('data' in entry) {
      yield entry.data;
    } else {
      let copied = 0;
      for await (const chunk of createReadStream(entry.file, { highWaterMark: 256 * 1024 })) {
        copied += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (copied !== size) throw new Error(`zip: ${entry.name} ha cambiado de tamaño`);
    }

    const zip64Offset = offset >= MAX32;
    const extra = zip64Offset ? Buffer.alloc(12) : Buffer.alloc(0);
    if (zip64Offset) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(offset), 4);
    }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(zip64Offset ? 45 : 20, 4); // hecho por
    head.writeUInt16LE(zip64Offset ? 45 : 20, 6); // versión necesaria
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc >>> 0, 16);
    head.writeUInt32LE(size, 20);
    head.writeUInt32LE(size, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(extra.length, 30);
    head.writeUInt16LE(0, 32); // comentario
    head.writeUInt16LE(0, 34); // disco
    head.writeUInt16LE(0, 36); // atributos internos
    head.writeUInt32LE(0, 38); // atributos externos
    head.writeUInt32LE(zip64Offset ? MAX32 : offset, 42);
    central.push(head, name, extra);

    offset += 30 + name.length + size;
    count++;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const part of central) {
    cdSize += part.length;
    yield part;
  }

  const needs64 = count >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  if (needs64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    yield rec;
    yield loc;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

