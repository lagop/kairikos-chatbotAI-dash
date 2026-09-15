// =============================================================================
// Fase 5a — genera los PNG del icono de la app.
//
// POR QUÉ UN GENERADOR Y NO UN PNG COMPROMETIDO A PELO: un binario en git
// no se puede revisar en un diff ni regenerar cuando cambie la marca.
// Esto es el diseño en código; los PNG que produce sí se comprometen,
// porque el build no puede depender de ejecutar esto.
//
// POR QUÉ NO ImageResponse de next/og, que sería lo idiomático: revienta
// el build en Windows (`TypeError: Invalid URL` en fileURLToPath, dentro
// de @vercel/og). Seguramente funciona en el Linux del CI, pero un build
// que solo pasa en una plataforma es un build roto para quien desarrolle
// en la otra.
//
// Regenerar:  node scripts/generate-icons.mjs
// =============================================================================
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA sin filtrar → PNG. Filtro 0 en cada scanline: el deflate se come
 *  de sobra la redundancia de un degradado plano. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits por canal
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Los dos acentos de la marca: --kairikos-accent y --kairikos-accent2.
const A = [0x6d, 0x3f, 0xf2];
const B = [0x0b, 0x6f, 0x8c];

/**
 * La "K" dibujada como geometría y no como tipografía: sin renderizador
 * de fuentes no hay forma de rasterizar texto, y tres trazos se calculan
 * con aritmética de sobra.
 *
 * `safe` es el margen que Android puede recortar en un icono maskable —
 * solo el 80% central está garantizado, así que la marca vive dentro.
 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const safe = size * 0.28;          // media altura de la letra
  const cx = size / 2;
  const cy = size / 2;
  const stroke = size * 0.085;
  const top = cy - safe;
  const bottom = cy + safe;
  // La letra ocupa de stemX a stemX + 0.95*safe, así que el palo va medio
  // ancho a la izquierda del centro para que el conjunto quede centrado.
  // Con un valor mayor (0.62 en el primer intento) la K se ve claramente
  // corrida hacia la izquierda dentro del cuadrado.
  const stemX = cx - safe * 0.475;

  const near = (px, py, ax, ay, bx, by) => {
    // Distancia de un punto al segmento AB.
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Degradado diagonal, el mismo 135° de la interfaz.
      const t = (x / size + y / size) / 2;
      let r = Math.round(A[0] + (B[0] - A[0]) * t);
      let g = Math.round(A[1] + (B[1] - A[1]) * t);
      let b = Math.round(A[2] + (B[2] - A[2]) * t);

      const d = Math.min(
        near(x, y, stemX, top, stemX, bottom),                      // el palo
        near(x, y, stemX, cy, stemX + safe * 0.95, top),            // diagonal arriba
        near(x, y, stemX, cy, stemX + safe * 0.95, bottom),         // diagonal abajo
      );
      // Antialiasing de un píxel: sin esto los diagonales salen escalonados.
      const ink = Math.max(0, Math.min(1, (stroke / 2 - d) + 0.5));
      if (ink > 0) {
        r = Math.round(r + (255 - r) * ink);
        g = Math.round(g + (255 - g) * ink);
        b = Math.round(b + (255 - b) * ink);
      }
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

for (const [size, name] of [[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-icon.png']]) {
  writeFileSync(new URL(`../public/icons/${name}`, import.meta.url), drawIcon(size));
  console.log(`public/icons/${name}  ${size}x${size}`);
}
