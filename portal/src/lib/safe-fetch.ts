import 'server-only';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

// =============================================================================
// Descarga de URLs que escribe un cliente, sin dejar que apunten dentro.
//
// Cinco sitios del portal descargan una URL que controla el cliente: el
// rastreo de conocimiento del chatbot, la auditoría SEO, la publicación en
// WordPress, la lectura de la web en Prospección y el webhook de leads. Hasta
// el 22/09/2026 usaban `fetch` directo, con un filtro que miraba el NOMBRE del
// host una sola vez y luego seguía redirecciones (y en dos de ellos, sin
// filtro). Un cliente de pago podía leer n8n u otros servicios internos de la
// VPS: `https://suyo.tld/r` responde 302 a `http://n8n:5678/...`, o un dominio
// que resuelve a 10.x, o `127.0.0.1.nip.io`. El rastreador guardaba la
// respuesta como conocimiento y bastaba preguntarle al propio bot.
//
// La comprobación que cuenta se hace AL CONECTAR, no antes: `http.request`
// recibe un `lookup` propio que resuelve el nombre y rechaza la conexión si
// alguna de las IPs es privada, reservada o de loopback. Así no hay hueco
// entre comprobar y conectar (DNS rebinding: el nombre resuelve a una IP
// pública al validar y a una interna al conectar), y cada redirección pasa
// por el mismo sitio porque es otra petición. Se hace con http/https de Node y
// no con `fetch` porque el `fetch` global no deja pasar un `lookup` sin añadir
// undici como dependencia.
//
// Además: solo http(s); las redirecciones solo se siguen en GET/HEAD (un POST
// con credenciales no se reenvía a otro sitio) y al cambiar de origen se
// quitan `authorization` y `cookie`; el cuerpo se corta en `maxBytes` DESPUÉS
// de descomprimir, para que un gzip pequeño no se infle a gigas en memoria.
//
// Devuelve un `Response` estándar para que quien llama cambie `fetch` por
// `safeFetch` y nada más. Un destino prohibido rechaza la promesa con
// `BlockedUrlError`, igual que un fallo de red.
// =============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`url_not_allowed:${reason}`);
    this.name = 'BlockedUrlError';
  }
}

// Rangos a los que nunca se conecta. IPv4: loopback, privadas (RFC 1918),
// CGNAT, enlace local (incluye 169.254.169.254, los metadatos de la nube),
// "esta red", documentación, benchmarking, multicast y reservadas. IPv6: sus
// equivalentes, más NAT64 (64:ff9b::/96), que alcanza IPv4 internas a
// través de una pasarela.
const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  // ::/96 cubre la dirección vacía, ::1 y las IPv4-compatibles en desuso
  // (::7f00:1 = 127.0.0.1).
  ['::', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6');
}

/** La IPv4 que lleva dentro una dirección `::ffff:a.b.c.d` (o su forma
 *  hexadecimal `::ffff:7f00:1`), o null si no es de ese tipo. */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

/** true si no se debe conectar nunca a esta IP. Una cadena que no es una IP
 *  también cuenta como prohibida: aquí solo llegan direcciones ya resueltas. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0];
  const version = net.isIP(bare);
  if (version === 4) return BLOCKED.check(bare, 'ipv4');
  if (version === 6) {
    const v4 = embeddedIPv4(bare);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(bare, 'ipv6');
  }
  return true;
}

type LookupFn = typeof dns.lookup;

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Corta la respuesta aquí, después de descomprimir. */
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

export interface SafeFetchDeps {
  /** Resolución de nombres. Inyectable para probar el rechazo sin red. */
  lookup?: LookupFn;
  isBlocked?: (address: string) => boolean;
}

/** Valida la forma de la URL antes de tocar la red. La IP la comprueba el
 *  `lookup` al conectar; aquí solo se descarta lo que no hace falta resolver
 *  para saber que no vale. */
function checkUrlShape(url: URL, isBlocked: (address: string) => boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('protocol');
  if (url.username || url.password) throw new BlockedUrlError('credentials_in_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Una IP escrita en la URL no pasa por `lookup`: se comprueba aquí. El
  // analizador de URL ya normaliza 127.1, 0x7f.1 o 2130706433 a 127.0.0.1.
  if (net.isIP(host)) {
    if (isBlocked(host)) throw new BlockedUrlError('address');
    return;
  }
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal') || lower.endsWith('.local')) {
    throw new BlockedUrlError('hostname');
  }
  // Un nombre sin punto es un servicio de la red interna ('n8n', 'app', 'db').
  if (!lower.includes('.')) throw new BlockedUrlError('hostname');
}

function guardedLookup(lookup: LookupFn, isBlocked: (address: string) => boolean): LookupFn {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    lookup(hostname, options, ((err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family: family ?? 0 }];
      if (list.length === 0 || list.some((entry) => isBlocked(entry.address))) {
        return callback(new BlockedUrlError('address'));
      }
      callback(null, address, family);
    }) as never);
  }) as LookupFn;
}

function decode(stream: Readable, encoding: string | undefined): Readable {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return stream.pipe(zlib.createGunzip());
    case 'deflate':
      return stream.pipe(zlib.createInflate());
    case 'br':
      return stream.pipe(zlib.createBrotliDecompress());
    default:
      return stream;
  }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const CROSS_ORIGIN_STRIPPED = new Set(['authorization', 'cookie']);

interface RawResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer | null;
}

function requestOnce(url: URL, init: SafeFetchInit, deps: Required<SafeFetchDeps>, maxBytes: number): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: { 'accept-encoding': 'gzip, deflate, br', ...init.headers },
        lookup: guardedLookup(deps.lookup, deps.isBlocked),
        signal: init.signal,
        timeout: init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'HEAD' || NULL_BODY_STATUS.has(status) || (status >= 300 && status < 400)) {
          res.resume();
          resolve({ status, headers: res.headers, body: null });
          return;
        }
        const stream = decode(res, res.headers['content-encoding'] as string | undefined);
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        };
        stream.on('data', (chunk: Buffer) => {
          if (done) return;
          const room = maxBytes - total;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            total = maxBytes;
            finish();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        stream.on('end', finish);
        stream.on('error', (err) => {
          if (!done) reject(err);
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // El cuerpo ya va descomprimido y quizá cortado: estas dos mentirían.
    if (name === 'content-encoding' || name === 'content-length') continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

export function createSafeFetch(deps: SafeFetchDeps = {}) {
  const resolved: Required<SafeFetchDeps> = {
    lookup: deps.lookup ?? dns.lookup,
    isBlocked: deps.isBlocked ?? isBlockedAddress,
  };

  return async function safeFetch(input: string, init: SafeFetchInit = {}): Promise<Response> {
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BlockedUrlError('invalid_url');
    }
    let headers = { ...init.headers };
    const method = (init.method ?? 'GET').toUpperCase();
    const followRedirects = method === 'GET' || method === 'HEAD';

    for (let hop = 0; ; hop++) {
      checkUrlShape(url, resolved.isBlocked);
      const raw = await requestOnce(url, { ...init, headers }, resolved, maxBytes);
      const location = raw.headers.location;
      if (followRedirects && raw.status >= 300 && raw.status < 400 && location) {
        if (hop >= maxRedirects) throw new BlockedUrlError('too_many_redirects');
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([name]) => !CROSS_ORIGIN_STRIPPED.has(name.toLowerCase())),
          );
        }
        url = next;
        continue;
      }
      const status = raw.status >= 200 && raw.status <= 599 ? raw.status : 502;
      const body = NULL_BODY_STATUS.has(status) || !raw.body ? null : new Uint8Array(raw.body);
      return new Response(body, { status, headers: toHeaders(raw.headers) });
    }
  };
}

export const safeFetch = createSafeFetch();
