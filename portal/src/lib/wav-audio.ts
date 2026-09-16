// =============================================================================
// WAV: codificar lo que graba el navegador y reconocer lo que llega al
// servidor. Puro, sin dependencias y sin 'server-only': lo usan el grabador
// del portal (cliente) y la validación de la locución (servidor).
//
// POR QUÉ WAV Y NO LO QUE GRABA EL NAVEGADOR: MediaRecorder produce WebM/Opus
// (Chrome, Firefox) o MP4/AAC (Safari), y el <Play> de Twilio solo acepta
// MP3, WAV, AIFF, GSM y μ-law. Convertir en el servidor exigiría ffmpeg en
// el contenedor; codificar PCM a WAV en el propio dispositivo son cuarenta
// líneas. A 16 kHz mono 16 bits, 30 segundos ocupan menos de 1 MB — y la
// línea telefónica va a 8 kHz, así que no se pierde nada que el que llama
// fuese a oír.
// =============================================================================

export const GREETING_SAMPLE_RATE = 16_000;

/** Reduce a `targetRate` promediando bloques. Suficiente para voz: el
 *  promedio actúa de filtro paso bajo tosco y evita el aliasing más
 *  audible de quedarse con una muestra de cada N. */
export function downsample(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (targetRate >= sourceRate) return samples;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** PCM 16 bits mono en un contenedor RIFF/WAVE. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // tamaño del bloque fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes por segundo
  view.setUint16(32, 2, true); // bytes por muestra
  view.setUint16(34, 16, true); // bits por muestra
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export type SniffedAudio =
  | { ok: true; mimeType: 'audio/wav'; durationSeconds: number }
  | { ok: true; mimeType: 'audio/mpeg'; durationSeconds: null }
  | { ok: false; error: 'unsupported_format' | 'corrupt_wav' };

const readAscii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * Qué es de verdad un fichero, mirando sus bytes y no su nombre ni su
 * Content-Type, que los pone quien lo sube.
 *
 * WAV: se recorren los bloques hasta `fmt ` y `data` para calcular la
 * duración — un WAV puede traer otros bloques (LIST, fact) antes de los
 * datos. MP3: basta la cabecera ID3 o una sincronía de trama; su duración
 * no se calcula (haría falta decodificar), así que el tope de tamaño es lo
 * que la acota.
 */
export function sniffAudio(bytes: Uint8Array): SniffedAudio {
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let byteRate: number | null = null;
    let dataSize: number | null = null;
    while (offset + 8 <= bytes.length) {
      const id = readAscii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      // byteRate ocupa los bytes 8–11 del bloque fmt, tras sus 8 de cabecera.
      // Comprobar hasta offset+16 no basta: un fichero truncado justo ahí
      // hacía que DataView lanzase en vez de devolver 'corrupt_wav'.
      if (id === 'fmt ' && offset + 20 <= bytes.length) {
        byteRate = view.getUint32(offset + 16, true);
      } else if (id === 'data') {
        // Algunos grabadores dejan el tamaño en 0 o en 0xFFFFFFFF cuando
        // escriben en streaming: se usa lo que de verdad hay.
        dataSize = Math.min(size, bytes.length - (offset + 8));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!byteRate || dataSize === null) return { ok: false, error: 'corrupt_wav' };
    return { ok: true, mimeType: 'audio/wav', durationSeconds: dataSize / byteRate };
  }

  const hasId3 = bytes.length >= 3 && readAscii(bytes, 0, 3) === 'ID3';
  const hasFrameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (hasId3 || hasFrameSync) return { ok: true, mimeType: 'audio/mpeg', durationSeconds: null };

  return { ok: false, error: 'unsupported_format' };
}
